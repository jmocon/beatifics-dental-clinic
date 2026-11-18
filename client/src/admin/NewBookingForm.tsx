import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  normalizePhMobile,
  SERVICES,
  STAFF_NOTES_MAX,
  staffBookingSchema,
  zodFieldErrors,
  type Booking,
  type StaffBookingInput,
} from '../../../shared/booking.ts';
import {
  addDays,
  formatDateShort,
  isClinicDay,
  isDateString,
  manilaHour,
  manilaToday,
  utcIsoToManilaLocal,
  weekdayOf,
} from '../../../shared/dates.ts';
import { freeDentists, type Dentist } from '../../../shared/dentists.ts';
import {
  dailySlots,
  DEFAULT_SETTINGS,
  durationFor,
  fits,
  isTimeString,
  rangeOf,
  slotRange,
  toMinutes,
  type ClinicSettings,
} from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';
import { useAdminApi, useAuth } from './auth.tsx';
import { useDentists } from './dentists.tsx';
import { emitBookingsChanged, type PanelContext } from './events.ts';
import { asClosures, closureHit, isValidDraft, ScheduleFields, type ScheduleResponse, type SlotDraft } from './ScheduleEditor.tsx';

interface PatientLookup {
  fullName: string;
  visits: number;
  noShows: number;
  lastVisit: string | null;
  regularDentistId: number | null;
}

/** Next clinic day from today: the starting guess before we know the schedule. */
function roughSlot(durationMinutes: number, dentistId: number | null): SlotDraft {
  let d = manilaToday();
  while (!isClinicDay(d)) d = addDays(d, 1);
  return { date: d, time: '09:00', durationMinutes, dentistId };
}

/** Start times still ahead of us on a date (later today, or the whole day for future dates). */
function remainingSlots(date: string, durationMinutes: number): string[] {
  const now = new Date();
  const slots = dailySlots(date, durationMinutes);
  if (date !== manilaToday(now)) return slots;
  const minutesNow = manilaHour(now) * 60 + now.getUTCMinutes(); // Manila is a whole-hour offset
  return slots.filter((t) => toMinutes(t) >= minutesNow);
}

/**
 * Earliest time in the next two weeks with room, so staff don't start from a full slot.
 * With dentists set up, it's the earliest time `preferred` is free (or anyone, if no preference).
 */
async function suggestFreeSlot(
  fetchDay: (date: string) => Promise<ScheduleResponse>,
  durationMinutes: number,
  dentists: Dentist[],
  preferred: number | null,
): Promise<SlotDraft | null> {
  for (let i = 0, d = manilaToday(); i < 14; i++, d = addDays(d, 1)) {
    const times = remainingSlots(d, durationMinutes);
    if (times.length === 0) continue;
    if (preferred !== null && !dentists.find((x) => x.id === preferred)?.workingDays.includes(weekdayOf(d))) continue;
    const { capacity, entries, closures } = await fetchDay(d);
    for (const t of times) {
      const range = slotRange(d, t, durationMinutes);
      if (dentists.length === 0) {
        const taken = entries.map((e) => rangeOf(e.startAt, e.durationMinutes));
        if (!closureHit(closures, t, durationMinutes) && fits(range, taken, capacity)) return { date: d, time: t, durationMinutes, dentistId: null };
        continue;
      }
      const free = freeDentists(
        {
          date: d,
          dentists,
          closures: asClosures(d, closures),
          bookings: entries.map((e) => ({ dentistId: e.dentistId, range: rangeOf(e.startAt, e.durationMinutes) })),
          capacity,
        },
        range,
        preferred,
      );
      if (free.length) return { date: d, time: t, durationMinutes, dentistId: free[0] };
    }
  }
  return null;
}

export function NewBookingForm() {
  const { refresh, backTo, detailHref, blockHref } = useOutletContext<PanelContext>();
  const adminApi = useAdminApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const mobileRef = useRef<HTMLInputElement>(null);

  const { user } = useAuth();
  const dentists = useDentists();

  // A calendar click passes the date, time and dentist column it was clicked on.
  const presetDate = params.get('date');
  const presetTime = params.get('time');
  const preset = presetDate && isDateString(presetDate) && presetTime && isTimeString(presetTime);
  const presetDentist = Number(params.get('dentist')) || null;
  const startDentist = presetDentist ?? user?.dentistId ?? null;

  const [settings, setSettings] = useState<ClinicSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [mobile, setMobile] = useState('');
  const [fullName, setFullName] = useState('');
  const [service, setService] = useState<string>(SERVICES[0]);
  const [slot, setSlot] = useState<SlotDraft>(() =>
    preset
      ? { date: presetDate, time: presetTime, durationMinutes: DEFAULT_SETTINGS.appointmentMinutes, dentistId: startDentist }
      : roughSlot(DEFAULT_SETTINGS.appointmentMinutes, startDentist),
  );
  const [confirmed, setConfirmed] = useState(true);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [patient, setPatient] = useState<PatientLookup | null>(null);
  const [autofilled, setAutofilled] = useState(false);
  const touchedTime = useRef(!!preset);
  const touchedDuration = useRef(false);
  const touchedDentist = useRef(!!presetDentist);

  useEffect(() => {
    document.title = 'New appointment · Beatifics Admin';
    mobileRef.current?.focus();
    adminApi<{ settings: ClinicSettings }>('/api/admin/settings')
      .then(({ settings: s }) => {
        setSettings(s);
        if (!touchedDuration.current) setSlot((d) => ({ ...d, durationMinutes: durationFor(s, SERVICES[0]) }));
      })
      .catch(() => {})
      .finally(() => setSettingsLoaded(true));
  }, [adminApi]);

  // Start from the earliest time with room (for this dentist, if one is chosen), unless staff already picked a time.
  useEffect(() => {
    if (!settingsLoaded || !dentists.loaded || touchedTime.current) return;
    const len = durationFor(settings, SERVICES[0]);
    suggestFreeSlot((date) => adminApi(`/api/admin/schedule?date=${date}`), len, dentists.active, startDentist)
      .then((free) => {
        if (free && !touchedTime.current) setSlot((d) => ({ ...free, dentistId: touchedDentist.current ? d.dentistId : free.dentistId }));
      })
      .catch(() => {});
    // Run once both are loaded.
  }, [settingsLoaded, dentists.loaded]);

  // Look up returning patients by mobile number and fill in their name (no typing for regulars).
  useEffect(() => {
    const normalized = normalizePhMobile(mobile);
    if (!normalized) {
      setPatient(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await adminApi<{ patient: PatientLookup | null }>(`/api/admin/patients/lookup?mobile=${normalized}`);
        setPatient(r.patient);
        // Keep returning patients with their usual dentist.
        if (r.patient?.regularDentistId && !touchedDentist.current) {
          setSlot((d) => ({ ...d, dentistId: r.patient!.regularDentistId }));
        }
        if (r.patient) {
          setFullName((current) => {
            if (current.trim()) return current;
            setAutofilled(true);
            return r.patient!.fullName;
          });
        }
      } catch {
        // Lookup is a convenience; ignore failures.
      }
    }, 250);
    return () => clearTimeout(t);
  }, [mobile, adminApi]);

  const clearError = (k: string) => errors[k] && setErrors(({ [k]: _, ...rest }) => rest);

  function chooseService(s: string) {
    setService(s);
    if (!touchedDuration.current) setSlot((d) => ({ ...d, durationMinutes: durationFor(settings, s) }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setFormError('');
    const body: StaffBookingInput = {
      fullName,
      mobile,
      service: service as StaffBookingInput['service'],
      startAt: isValidDraft(slot) ? `${slot.date}T${slot.time}` : '',
      durationMinutes: slot.durationMinutes,
      dentistId: slot.dentistId,
      status: confirmed ? 'confirmed' : 'pending',
      staffNotes: notes,
    };
    const parsed = staffBookingSchema.safeParse(body);
    if (!parsed.success) {
      const fields = zodFieldErrors(parsed.error);
      setErrors(fields);
      const first = ['mobile', 'fullName', 'service'].find((f) => fields[f]);
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const r = await adminApi<{ booking: Booking }>('/api/admin/bookings', { method: 'POST', body });
      refresh();
      emitBookingsChanged();
      navigate(detailHref(r.booking.id), {
        state: { flash: confirmed ? 'Appointment added and confirmed.' : 'Appointment added as pending.' },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(err.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  const err = (name: string) =>
    errors[name] ? (
      <span className="field-error" id={id(`${name}-error`)}>
        {errors[name]}
      </span>
    ) : null;
  const a11y = (name: string) => ({
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? id(`${name}-error`) : undefined,
  });

  return (
    <article className="detail" aria-labelledby={id('title')}>
      <Link to={backTo} className="detail-back">
        ← Back
      </Link>
      <header className="detail-head">
        <div>
          <h2 id={id('title')} ref={headingRef} tabIndex={-1}>
            New appointment
          </h2>
          <p className="detail-ref">For phone bookings and walk-ins. Returning patients fill in from their number.</p>
        </div>
        {blockHref && isValidDraft(slot) && (
          <Link to={blockHref(slot.date, slot.time, slot.dentistId)} className="btn btn-ghost btn-sm">
            Block this time instead
          </Link>
        )}
      </header>

      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}

      <form ref={formRef} className="new-booking" onSubmit={onSubmit} noValidate>
        <section className="detail-card" aria-labelledby={id('patient')}>
          <h3 id={id('patient')} className="detail-card-title">
            Patient
          </h3>
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor={id('mobile')}>
                Mobile number
              </label>
              <input
                ref={mobileRef}
                id={id('mobile')}
                name="mobile"
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="0917 123 4567"
                value={mobile}
                maxLength={20}
                onChange={(e) => {
                  setMobile(e.target.value);
                  clearError('mobile');
                  if (autofilled) {
                    setFullName('');
                    setAutofilled(false);
                  }
                }}
                onBlur={() =>
                  mobile.trim() &&
                  !normalizePhMobile(mobile) &&
                  setErrors((x) => ({ ...x, mobile: 'Enter a PH mobile number, e.g. 0917 123 4567.' }))
                }
                {...a11y('mobile')}
              />
              {err('mobile')}
            </div>
            <div className="field">
              <label className="field-label" htmlFor={id('fullName')}>
                Full name
              </label>
              <input
                id={id('fullName')}
                name="fullName"
                className="input"
                autoComplete="off"
                value={fullName}
                maxLength={100}
                onChange={(e) => {
                  setFullName(e.target.value);
                  setAutofilled(false);
                  clearError('fullName');
                }}
                {...a11y('fullName')}
              />
              {err('fullName')}
            </div>
          </div>
          {patient && (
            <div className="patient-found" role="status">
              <span>
                <strong>Returning patient.</strong>{' '}
                {patient.visits > 0
                  ? `${patient.visits} completed visit${patient.visits === 1 ? '' : 's'}${
                      patient.lastVisit ? `, last on ${formatDateShort(utcIsoToManilaLocal(patient.lastVisit).slice(0, 10))}` : ''
                    }`
                  : 'Has booked before, no completed visits yet'}
                {patient.noShows > 0 && <span className="tag tag-warn">{patient.noShows} no-show{patient.noShows > 1 ? 's' : ''}</span>}
              </span>
              {fullName.trim() !== patient.fullName && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setFullName(patient.fullName);
                    setAutofilled(true);
                    clearError('fullName');
                  }}
                >
                  Use “{patient.fullName}”
                </button>
              )}
            </div>
          )}
          <div className="field">
            <label className="field-label" htmlFor={id('service')}>
              Reason for visit
            </label>
            <select id={id('service')} name="service" className="select" value={service} onChange={(e) => chooseService(e.target.value)}>
              {SERVICES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {err('service')}
          </div>
        </section>

        <section className="detail-card" aria-labelledby={id('when')}>
          <h3 id={id('when')} className="detail-card-title">
            When
          </h3>
          <ScheduleFields
            value={slot}
            onChange={(d) => {
              if (d.durationMinutes !== slot.durationMinutes) touchedDuration.current = true;
              else if (d.dentistId !== slot.dentistId) touchedDentist.current = true;
              else touchedTime.current = true;
              setSlot(d);
              clearError('startAt');
            }}
            error={errors.startAt || errors.durationMinutes}
          />
          <label className="consent">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              <strong>Already agreed with the patient</strong>: add it as confirmed. Untick to add it as pending and confirm
              later.
            </span>
          </label>
        </section>

        <section className="detail-card" aria-labelledby={id('notes-title')}>
          <h3 id={id('notes-title')} className="detail-card-title">
            <label htmlFor={id('notes')}>Staff notes</label>
          </h3>
          <p className="field-hint">Optional. Only visible to clinic staff.</p>
          <textarea
            id={id('notes')}
            className="textarea"
            rows={2}
            maxLength={STAFF_NOTES_MAX}
            placeholder="e.g. Booked by phone. Prefers a female assistant."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </section>

        <div className="action-row new-booking-actions">
          <button type="submit" className="btn btn-primary btn-lg" disabled={saving}>
            {saving && <span className="spinner" aria-hidden="true" />}
            Add appointment
          </button>
          <Link to={backTo} className="btn btn-ghost btn-lg">
            Cancel
          </Link>
        </div>
      </form>
    </article>
  );
}
