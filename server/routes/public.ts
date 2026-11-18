import express from 'express';
import { bookingRequestSchema, manageLookupSchema, rescheduleSchema, type Booking, type PublicBooking } from '../../shared/booking.ts';
import { SERVICES } from '../../shared/constants.ts';
import { manilaLocalToUtcIso } from '../../shared/dates.ts';
import { logAudit } from '../audit.ts';
import { createBooking, findForPatient, getAvailability, patientCanChange, pickSlot, updateBooking } from '../bookings.ts';
import { dentistName, parseBody, slotEnv, whenText, type Ctx } from '../context.ts';
import { publicDentists } from '../dentists.ts';

const PATIENT = { type: 'patient' } as const;

export function publicRoutes({ db, now, limit }: Ctx) {
  const r = express.Router();

  function toPublic(b: Booking): PublicBooking {
    return {
      reference: b.reference,
      firstName: b.fullName.split(/\s+/)[0],
      service: b.service,
      status: b.status,
      startAt: b.startAt,
      durationMinutes: b.durationMinutes,
      dentistName: dentistName(db, b.dentistId),
      canChange: patientCanChange(b, now()),
    };
  }

  /** '?dentist=3' → 3, anything else ('any', missing) → null. */
  const dentistParam = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  r.get('/dentists', (_req, res) => {
    res.json({ dentists: publicDentists(db) });
  });

  r.post(
    '/bookings',
    limit({ windowMs: 15 * 60_000, max: 8, message: 'Too many requests. Please try again later or call the clinic.' }),
    (req, res) => {
      // Honeypot: real people never fill the hidden "website" field.
      if (typeof req.body?.website === 'string' && req.body.website.trim() !== '') {
        res.status(201).json({ reference: 'BD-RECVD', duplicate: false });
        return;
      }
      const data = parseBody(bookingRequestSchema(now()), req, res);
      if (!data) return;
      const env = slotEnv(db, now());
      if (data.dentistId !== null && env.dentists.length > 0 && !env.dentists.some((d) => d.id === data.dentistId)) {
        res.status(400).json({ error: 'Please choose a dentist from the list.', fields: { dentistId: 'Please choose a dentist from the list.' } });
        return;
      }
      const result = createBooking(db, data, env, now());
      if ('slotTaken' in result) {
        res.status(409).json({
          error: 'Sorry, that time was just taken. Please choose another time.',
          fields: { preferredTime: 'That time is no longer available. Please choose another.' },
        });
        return;
      }
      const { booking, duplicate } = result;
      const name = dentistName(db, booking.dentistId);
      if (!duplicate) {
        logAudit(
          db,
          PATIENT,
          'booking.requested',
          `Requested online for ${whenText(booking.startAt, booking.durationMinutes, name)}${booking.dentistRequested ? ' (asked for this dentist)' : ''}`,
          now(),
          booking.id,
        );
      }
      res.status(duplicate ? 200 : 201).json({
        reference: booking.reference,
        startAt: booking.startAt,
        durationMinutes: booking.durationMinutes,
        dentistName: name,
        duplicate,
      });
    },
  );

  r.get(
    '/availability',
    limit({ windowMs: 60_000, max: 60, message: 'Too many requests. Please wait a moment.' }),
    (req, res) => {
      const service = String(req.query.service ?? '');
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        getAvailability(
          db,
          slotEnv(db, now()),
          {
            service: (SERVICES as readonly string[]).includes(service) ? service : SERVICES[0],
            dentistId: dentistParam(req.query.dentist),
          },
          now(),
        ),
      );
    },
  );

  // ---------- Manage my booking ----------

  const manageLimit = limit({
    windowMs: 15 * 60_000,
    max: 20,
    message: 'Too many attempts. Please wait a few minutes or call the clinic.',
  });

  /** Find the booking for reference + mobile, or send 404 with a gentle message. */
  function lookup(req: express.Request, res: express.Response): Booking | null {
    const data = parseBody(manageLookupSchema, req, res);
    if (!data) return null;
    const booking = findForPatient(db, data.reference, data.mobile);
    if (!booking) {
      res.status(404).json({
        error: 'We couldn’t find a booking with that reference and mobile number. Please check both, or call the clinic.',
      });
      return null;
    }
    return booking;
  }

  function requireChangeable(b: Booking, res: express.Response): boolean {
    if (patientCanChange(b, now())) return true;
    res.status(409).json({
      error:
        b.status === 'pending' || b.status === 'confirmed'
          ? 'Your appointment is today or has passed, so it can’t be changed online. Please call the clinic.'
          : 'This booking can no longer be changed online. Please call the clinic.',
    });
    return false;
  }

  r.post('/manage/lookup', manageLimit, (req, res) => {
    const b = lookup(req, res);
    if (b) res.json({ booking: toPublic(b) });
  });

  r.post('/manage/availability', manageLimit, (req, res) => {
    const b = lookup(req, res);
    if (!b || !requireChangeable(b, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      getAvailability(
        db,
        slotEnv(db, now()),
        // Keep the dentist they asked for; otherwise any dentist will do.
        { service: b.service, duration: b.durationMinutes, excludeId: b.id, dentistId: b.dentistRequested ? b.dentistId : null },
        now(),
      ),
    );
  });

  r.post('/manage/cancel', manageLimit, (req, res) => {
    const b = lookup(req, res);
    if (!b || !requireChangeable(b, res)) return;
    const updated = updateBooking(db, b, { status: 'cancelled' }, 'Patient', now());
    logAudit(db, PATIENT, 'booking.cancelled_by_patient', `Cancelled online (was ${whenText(b.startAt, b.durationMinutes)})`, now(), b.id);
    res.json({ booking: toPublic(updated) });
  });

  r.post('/manage/reschedule', manageLimit, (req, res) => {
    const b = lookup(req, res);
    if (!b || !requireChangeable(b, res)) return;
    const slot = parseBody(rescheduleSchema(now()), req, res);
    if (!slot) return;
    const pick = pickSlot(db, slotEnv(db, now()), slot.preferredDate, slot.preferredTime, b.durationMinutes, {
      excludeId: b.id,
      only: b.dentistRequested ? b.dentistId : null,
      preferred: b.dentistId,
    });
    if (!pick.ok) {
      res.status(409).json({
        error: 'Sorry, that time was just taken. Please choose another time.',
        fields: { preferredTime: 'That time is no longer available. Please choose another.' },
      });
      return;
    }
    const startAt = manilaLocalToUtcIso(`${slot.preferredDate}T${slot.preferredTime}`)!;
    // A moved appointment needs the clinic to confirm the new time again.
    const updated = updateBooking(
      db,
      b,
      { status: 'pending', startAt, dentistId: pick.dentistId ?? b.dentistId },
      'Patient',
      now(),
    );
    logAudit(
      db,
      PATIENT,
      'booking.rescheduled_by_patient',
      `Moved online from ${whenText(b.startAt, b.durationMinutes)} to ${whenText(startAt, b.durationMinutes, dentistName(db, updated.dentistId))}`,
      now(),
      b.id,
    );
    res.json({ booking: toPublic(updated) });
  });

  return r;
}
