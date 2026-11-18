import express from 'express';
import {
  bookingUpdateSchema,
  canTransition,
  newUserSchema,
  normalizePhMobile,
  ROLE_LABELS,
  staffBookingSchema,
  STATUS_LABELS,
  updateUserSchema,
  type BookingDetailResponse,
  type BookingListResponse,
  type BookingStatus,
  type BookingView,
  type ScheduleEntry,
  type StaffUser,
  type UpdatesResponse,
} from '../../shared/booking.ts';
import { addDays, isDateString, manilaLocalToUtcIso, manilaToday } from '../../shared/dates.ts';
import {
  closureRangesOn,
  closureSchema,
  describeClosure,
  formatDuration,
  rangeOf,
  settingsSchema,
  type Closure,
} from '../../shared/schedule.ts';
import { auditForBooking, logAudit, patientEventsSince, recentAudit, type Actor } from '../audit.ts';
import {
  countActiveAdmins,
  createUser,
  emailTaken,
  getAccount,
  listAccounts,
  requireAdmin,
  requireStaff,
  updateAccount,
} from '../auth.ts';
import {
  autoAssignUnassigned,
  BOOKING_VIEWS,
  buildReport,
  calendarEntries,
  countBookings,
  countPending,
  countUnassignedUpcoming,
  createStaffBooking,
  getBooking,
  listBookings,
  lookupPatient,
  patientHistory,
  scheduleForDay,
  updateBooking,
  type DentistFilter,
} from '../bookings.ts';
import { activeClosures, closureWindow, createClosure, deleteClosure, getClosure } from '../closures.ts';
import { dentistName, idParam, parseBody, slotEnv, whenText, type Ctx } from '../context.ts';
import { createDentist, getDentist, listDentists, updateDentist, userLinkedElsewhere } from '../dentists.ts';
import { dentistSchema, dentistUpdateSchema, describeWorkingDays } from '../../shared/dentists.ts';
import { getSettings, saveSettings } from '../settings.ts';

export function adminRoutes({ db, now }: Ctx) {
  const r = express.Router();
  r.use(requireStaff(db, now));

  const staffOf = (res: express.Response) => res.locals.staff as StaffUser;
  const actor = (res: express.Response): Actor => ({ type: 'staff', user: staffOf(res) });

  // ---------- Bookings ----------

  /** 400 unless `id` is null or an active dentist. */
  function checkDentist(id: number | null | undefined, res: express.Response): boolean {
    if (id === null || id === undefined) return true;
    const d = getDentist(db, id);
    if (d?.active) return true;
    res.status(400).json({ error: 'Choose a dentist from the list.', fields: { dentistId: 'Choose a dentist from the list.' } });
    return false;
  }

  r.get('/bookings', (req, res) => {
    const view = (BOOKING_VIEWS as string[]).includes(String(req.query.view)) ? (req.query.view as BookingView) : 'action';
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const raw = String(req.query.dentist ?? '');
    const dentist: DentistFilter = raw === 'unassigned' ? 'unassigned' : Number(raw) > 0 ? Number(raw) : null;
    const body: BookingListResponse = {
      bookings: listBookings(db, view, q, now(), dentist),
      counts: countBookings(db, now(), dentist),
    };
    res.json(body);
  });

  r.post('/bookings', (req, res) => {
    const data = parseBody(staffBookingSchema, req, res);
    if (!data || !checkDentist(data.dentistId, res)) return;
    const booking = createStaffBooking(db, data, staffOf(res).name, now());
    logAudit(
      db,
      actor(res),
      'booking.created',
      `Added ${data.status === 'confirmed' ? 'and confirmed ' : ''}for ${whenText(booking.startAt, booking.durationMinutes, dentistName(db, booking.dentistId))}`,
      now(),
      booking.id,
    );
    res.status(201).json({ booking });
  });

  r.get('/bookings/:id', (req, res) => {
    const id = idParam(req);
    const booking = id ? getBooking(db, id) : null;
    if (!booking) {
      res.status(404).json({ error: 'Booking not found.' });
      return;
    }
    const body: BookingDetailResponse = {
      booking,
      history: patientHistory(db, booking.mobile, booking.id),
      activity: auditForBooking(db, booking.id),
    };
    res.json(body);
  });

  r.patch('/bookings/:id', (req, res) => {
    const id = idParam(req);
    const current = id ? getBooking(db, id) : null;
    if (!id || !current) {
      res.status(404).json({ error: 'Booking not found.' });
      return;
    }
    const input = parseBody(bookingUpdateSchema, req, res);
    if (!input || !checkDentist(input.dentistId, res)) return;
    const status: BookingStatus = input.status ?? current.status;

    if (!canTransition(current.status, status)) {
      res.status(409).json({
        error: `A ${STATUS_LABELS[current.status].toLowerCase()} booking can’t be changed to ${STATUS_LABELS[status].toLowerCase()}.`,
      });
      return;
    }
    const changesTime = input.startAt !== undefined || input.durationMinutes !== undefined || input.dentistId !== undefined;
    if (changesTime && status !== 'pending' && status !== 'confirmed') {
      res.status(400).json({ error: 'The time and dentist can only be changed on pending or confirmed bookings.' });
      return;
    }

    // Staff may go over capacity on purpose (e.g. squeezing in an emergency); the portal warns them first.
    const startAt = input.startAt !== undefined ? manilaLocalToUtcIso(input.startAt)! : current.startAt;
    const durationMinutes = input.durationMinutes ?? current.durationMinutes;
    const dentistChanged = input.dentistId !== undefined && input.dentistId !== current.dentistId;
    const booking = updateBooking(
      db,
      current,
      {
        status,
        startAt,
        durationMinutes,
        staffNotes: input.staffNotes,
        dentistId: input.dentistId,
        // Once staff move a patient to someone else, the original request no longer applies.
        dentistRequested: dentistChanged ? false : undefined,
      },
      staffOf(res).name,
      now(),
    );
    const dName = dentistName(db, booking.dentistId);

    // Describe the change for the activity log.
    const timeMoved = startAt !== current.startAt || durationMinutes !== current.durationMinutes;
    const parts: string[] = [];
    if (status !== current.status) {
      parts.push(
        status === 'confirmed'
          ? `Confirmed for ${whenText(startAt, durationMinutes, dName)}`
          : status === 'pending'
            ? 'Reopened'
            : status === 'completed'
              ? 'Marked completed'
              : status === 'no_show'
                ? 'Marked no-show'
                : 'Cancelled',
      );
    } else if (timeMoved) {
      parts.push(`Moved to ${whenText(startAt, durationMinutes, dentistChanged ? dName : null)}`);
    }
    if (dentistChanged && !(status !== current.status && status === 'confirmed') && !timeMoved) {
      parts.push(dName ? `Assigned to ${dName}` : 'Unassigned from dentist');
    }
    if (input.staffNotes !== undefined && input.staffNotes !== current.staffNotes) parts.push('Updated staff notes');
    if (parts.length) {
      logAudit(db, actor(res), status !== current.status ? `booking.${status}` : 'booking.updated', parts.join('; '), now(), id);
    }
    res.json({ booking });
  });

  // ---------- Patients ----------

  r.get('/patients/lookup', (req, res) => {
    const mobile = normalizePhMobile(String(req.query.mobile ?? ''));
    res.json({ patient: mobile ? lookupPatient(db, mobile) : null });
  });

  // ---------- Schedule & calendar ----------

  r.get('/schedule', (req, res) => {
    const date = String(req.query.date ?? '');
    if (!isDateString(date)) {
      res.status(400).json({ error: 'Choose a valid date.' });
      return;
    }
    const closures = activeClosures(db, date).filter((c) => closureRangesOn([c], date).length > 0);
    res.json({
      date,
      capacity: getSettings(db).capacity,
      entries: scheduleForDay(db, date),
      closures: closures.map((c) => ({ id: c.id, startTime: c.startTime, endTime: c.endTime, reason: c.reason, dentistId: c.dentistId })),
    });
  });

  r.get('/calendar', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!isDateString(from) || !isDateString(to) || to < from || addDays(from, 42) < to) {
      res.status(400).json({ error: 'Choose a valid date range (up to 6 weeks).' });
      return;
    }
    res.json({
      from,
      to,
      capacity: getSettings(db).capacity,
      entries: calendarEntries(db, from, to),
      closures: activeClosures(db, from).filter((c) => c.startDate <= to),
      dentists: listDentists(db),
    });
  });

  // ---------- Dentists ----------

  r.get('/dentists', (_req, res) => {
    res.json({ dentists: listDentists(db), unassignedUpcoming: countUnassignedUpcoming(db, now()) });
  });

  /** 400 if the account doesn't exist or already belongs to another dentist. */
  function checkLinkedUser(userId: number | null | undefined, dentistId: number | null, res: express.Response): boolean {
    if (userId === null || userId === undefined) return true;
    if (!getAccount(db, userId)) {
      res.status(400).json({ error: 'That staff account doesn’t exist.', fields: { userId: 'Choose an account from the list.' } });
      return false;
    }
    if (userLinkedElsewhere(db, userId, dentistId)) {
      res.status(409).json({ error: 'That account is already linked to another dentist.', fields: { userId: 'Already linked to another dentist.' } });
      return false;
    }
    return true;
  }

  r.post('/dentists', requireAdmin, (req, res) => {
    const data = parseBody(dentistSchema, req, res);
    if (!data || !checkLinkedUser(data.userId, null, res)) return;
    const dentist = createDentist(db, data, now());
    logAudit(db, actor(res), 'dentist.added', `Added dentist ${dentist.name} (${describeWorkingDays(dentist.workingDays)})`, now());
    res.status(201).json({ dentist });
  });

  r.patch('/dentists/:id', requireAdmin, (req, res) => {
    const id = idParam(req);
    const current = id ? getDentist(db, id) : null;
    if (!id || !current) {
      res.status(404).json({ error: 'Dentist not found.' });
      return;
    }
    const data = parseBody(dentistUpdateSchema, req, res);
    if (!data || !checkLinkedUser(data.userId, id, res)) return;
    const dentist = updateDentist(db, id, data);
    const parts: string[] = [];
    if (data.name !== undefined && data.name !== current.name) parts.push(`renamed to ${data.name}`);
    if (data.workingDays !== undefined && JSON.stringify(data.workingDays) !== JSON.stringify(current.workingDays))
      parts.push(`works ${describeWorkingDays(dentist.workingDays)}`);
    if (data.active !== undefined && data.active !== current.active) parts.push(data.active ? 'reactivated' : 'deactivated');
    if (data.userId !== undefined && data.userId !== current.userId)
      parts.push(data.userId ? `linked to ${getAccount(db, data.userId)?.name ?? 'an account'}` : 'login unlinked');
    if (parts.length) logAudit(db, actor(res), 'dentist.updated', `${current.name}: ${parts.join(', ')}`, now());
    res.json({ dentist });
  });

  r.post('/dentists/auto-assign', requireAdmin, (_req, res) => {
    const env = slotEnv(db, now());
    if (env.dentists.length === 0) {
      res.status(409).json({ error: 'Add a dentist first.' });
      return;
    }
    const result = autoAssignUnassigned(db, env, staffOf(res).name, now());
    if (result.assigned) logAudit(db, actor(res), 'dentist.auto_assigned', `Assigned ${result.assigned} upcoming booking(s) to free dentists`, now());
    res.json(result);
  });

  // ---------- Closures & blocked times ----------

  /** Active bookings that a closure would cover. */
  function affectedBy(c: Omit<Closure, 'id'>): ScheduleEntry[] {
    const { from, to } = closureWindow(c);
    const start = from < manilaToday(now()) ? manilaToday(now()) : from;
    if (start > to) return [];
    const out: ScheduleEntry[] = [];
    for (const e of calendarEntries(db, start, to)) {
      if (e.status !== 'pending' && e.status !== 'confirmed') continue;
      // A dentist's own time off only affects their patients.
      if (c.dentistId !== null && e.dentistId !== c.dentistId) continue;
      const date = new Date(new Date(e.startAt).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
      const blocked = closureRangesOn([{ ...c, id: 0 }], date);
      const range = rangeOf(e.startAt, e.durationMinutes);
      if (blocked.some((b) => b.start < range.end && b.end > range.start)) out.push(e);
    }
    return out;
  }

  r.get('/closures', (_req, res) => {
    res.json({ closures: activeClosures(db, manilaToday(now())) });
  });

  r.post('/closures/preview', (req, res) => {
    const data = parseBody(closureSchema, req, res);
    if (data && checkDentist(data.dentistId, res)) res.json({ affected: affectedBy(data) });
  });

  r.post('/closures', (req, res) => {
    const data = parseBody(closureSchema, req, res);
    if (!data || !checkDentist(data.dentistId, res)) return;
    const closure = createClosure(db, data, staffOf(res).name, now());
    const d = describeClosure(closure);
    const who = closure.dentistId ? ` for ${dentistName(db, closure.dentistId)}` : '';
    logAudit(db, actor(res), 'closure.added', `Blocked${who} ${d.when}, ${d.time.toLowerCase()}${closure.reason ? ` (${closure.reason})` : ''}`, now());
    res.status(201).json({ closure, affected: affectedBy(closure) });
  });

  r.delete('/closures/:id', (req, res) => {
    const id = idParam(req);
    const closure = id ? getClosure(db, id) : null;
    if (!id || !closure) {
      res.status(404).json({ error: 'That blocked time no longer exists.' });
      return;
    }
    deleteClosure(db, id);
    const d = describeClosure(closure);
    logAudit(db, actor(res), 'closure.removed', `Unblocked ${d.when}, ${d.time.toLowerCase()}`, now());
    res.status(204).end();
  });

  // ---------- Alerts ----------

  r.get('/updates', (req, res) => {
    const since = String(req.query.since ?? '');
    const serverTime = now().toISOString();
    const body: UpdatesResponse = {
      serverTime,
      pending: countPending(db),
      events: /^\d{4}-\d{2}-\d{2}T/.test(since) ? patientEventsSince(db, since) : [],
    };
    res.json(body);
  });

  // ---------- Reports ----------

  r.get('/reports', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!isDateString(from) || !isDateString(to) || to < from || addDays(from, 400) < to) {
      res.status(400).json({ error: 'Choose a valid date range (up to a year).' });
      return;
    }
    res.json(buildReport(db, from, to, listDentists(db)));
  });

  // ---------- Settings ----------

  r.get('/settings', (_req, res) => {
    res.json({ settings: getSettings(db) });
  });

  r.put('/settings', requireAdmin, (req, res) => {
    const data = parseBody(settingsSchema, req, res);
    if (!data) return;
    const before = getSettings(db);
    const saved = saveSettings(db, data);
    const changes: string[] = [];
    if (before.appointmentMinutes !== saved.appointmentMinutes)
      changes.push(`time per patient ${formatDuration(saved.appointmentMinutes)}`);
    if (before.capacity !== saved.capacity) changes.push(`${saved.capacity} patients at the same time`);
    if (JSON.stringify(before.serviceMinutes) !== JSON.stringify(saved.serviceMinutes)) changes.push('service lengths');
    if (changes.length) logAudit(db, actor(res), 'settings.updated', `Changed ${changes.join(', ')}`, now());
    res.json({ settings: saved });
  });

  // ---------- Staff accounts (admin only) ----------

  r.get('/users', requireAdmin, (_req, res) => {
    res.json({ users: listAccounts(db) });
  });

  r.post('/users', requireAdmin, async (req, res) => {
    const data = parseBody(newUserSchema, req, res);
    if (!data) return;
    if (emailTaken(db, data.email)) {
      res.status(409).json({ error: 'That email already has an account.', fields: { email: 'Already in use.' } });
      return;
    }
    const user = await createUser(db, data.email, data.name, data.password, data.role);
    logAudit(db, actor(res), 'user.added', `Added ${ROLE_LABELS[user.role].toLowerCase()} account for ${user.name}`, now());
    res.status(201).json({ user: getAccount(db, user.id) });
  });

  r.patch('/users/:id', requireAdmin, async (req, res) => {
    const id = idParam(req);
    const target = id ? getAccount(db, id) : null;
    if (!id || !target) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const data = parseBody(updateUserSchema, req, res);
    if (!data) return;
    const me = staffOf(res);
    if (id === me.id && (data.active === false || data.role === 'staff')) {
      res.status(409).json({ error: 'You can’t deactivate or demote your own account. Ask another admin.' });
      return;
    }
    const losesAdmin = target.role === 'admin' && target.active && (data.role === 'staff' || data.active === false);
    if (losesAdmin && countActiveAdmins(db) <= 1) {
      res.status(409).json({ error: 'The clinic needs at least one active admin.' });
      return;
    }
    const updated = await updateAccount(db, id, data);
    const parts: string[] = [];
    if (data.name !== undefined && data.name !== target.name) parts.push(`renamed to ${data.name}`);
    if (data.role !== undefined && data.role !== target.role) parts.push(`role ${ROLE_LABELS[data.role].toLowerCase()}`);
    if (data.active !== undefined && data.active !== target.active) parts.push(data.active ? 'reactivated' : 'deactivated');
    if (data.password !== undefined) parts.push('password reset');
    if (parts.length) logAudit(db, actor(res), 'user.updated', `${target.name}: ${parts.join(', ')}`, now());
    res.json({ user: updated });
  });

  r.get('/activity', requireAdmin, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ activity: recentAudit(db, limit) });
  });

  return r;
}
