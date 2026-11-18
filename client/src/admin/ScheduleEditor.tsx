import { useEffect, useId, useState } from 'react';
import type { Booking, ScheduleEntry } from '../../../shared/booking.ts';
import {
  CLINIC_HOURS,
  formatDateLong,
  isDateString,
  manilaLocalToUtcIso,
  utcIsoToManilaLocal,
  weekdayOf,
  WEEKDAY_NAMES,
} from '../../../shared/dates.ts';
import { freeDentists, worksOn } from '../../../shared/dentists.ts';
import {
  DURATION_OPTIONS,
  formatDuration,
  formatTime,
  fromMinutes,
  isTimeString,
  maxOverlap,
  rangeOf,
  toMinutes,
  type Closure,
} from '../../../shared/schedule.ts';
import { useAdminApi } from './auth.tsx';
import { DentistSelect, useDentists } from './dentists.tsx';
import { StatusBadge } from './StatusBadge.tsx';

export interface ScheduleResponse {
  date: string;
  capacity: number;
  entries: ScheduleEntry[];
  closures: Array<{ id: number; startTime: string | null; endTime: string | null; reason: string; dentistId: number | null }>;
}

/** Editable slot: Manila date 'YYYY-MM-DD', time 'HH:mm', length in minutes, dentist. */
export interface SlotDraft {
  date: string;
  time: string;
  durationMinutes: number;
  dentistId: number | null;
}

export interface ScheduleValue {
  /** Manila 'YYYY-MM-DDTHH:mm' */
  startAt: string;
  durationMinutes: number;
  dentistId: number | null;
}

const endTime = (time: string, minutes: number) => fromMinutes(toMinutes(time) + minutes);

const closureLabel = (c: ScheduleResponse['closures'][number]) =>
  `${c.reason || 'Blocked'} (${c.startTime && c.endTime ? `${formatTime(c.startTime)} – ${formatTime(c.endTime)}` : 'all day'})`;

/**
 * Does a slot overlap a blocked time? Clinic-wide closures always count;
 * a dentist's own closures count only when `dentistId` is that dentist.
 */
export function closureHit(closures: ScheduleResponse['closures'], time: string, duration: number, dentistId: number | null = null) {
  const s = toMinutes(time);
  const e = s + duration;
  return closures.find(
    (c) =>
      (c.dentistId === null || c.dentistId === dentistId) &&
      (!c.startTime || !c.endTime || (toMinutes(c.startTime) < e && toMinutes(c.endTime) > s)),
  );
}

/** Turn a day's schedule into the closures shape the shared availability logic expects. */
export function asClosures(date: string, closures: ScheduleResponse['closures']): Array<Closure & { dentistId: number | null }> {
  return closures.map((c) => ({ ...c, startDate: date, endDate: null, repeat: 'none' as const }));
}

export const isValidDraft = (d: SlotDraft) => isDateString(d.date) && isTimeString(d.time);

export function draftFromBooking(b: Pick<Booking, 'startAt' | 'durationMinutes' | 'dentistId'>): SlotDraft {
  const local = utcIsoToManilaLocal(b.startAt);
  return { date: local.slice(0, 10), time: local.slice(11, 16), durationMinutes: b.durationMinutes, dentistId: b.dentistId };
}

/**
 * Date, start, length and dentist inputs with a live view of that day's other appointments
 * and warnings (past, closed, off, busy, blocked, over capacity). Staff can still save.
 */
export function ScheduleFields({
  value,
  onChange,
  excludeId,
  error,
}: {
  value: SlotDraft;
  onChange: (next: SlotDraft) => void;
  /** The booking being edited, so it doesn't count against itself. */
  excludeId?: number;
  error?: string;
}) {
  const uid = useId();
  const adminApi = useAdminApi();
  const { active: dentists, byId } = useDentists();
  const { date, time, durationMinutes: duration, dentistId } = value;
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [scheduleError, setScheduleError] = useState('');

  useEffect(() => {
    if (!isDateString(date)) return;
    const ctrl = new AbortController();
    setScheduleError('');
    adminApi<ScheduleResponse>(`/api/admin/schedule?date=${date}`, { signal: ctrl.signal })
      .then(setSchedule)
      .catch((err) => (err as Error).name !== 'AbortError' && setScheduleError('Couldn’t load the schedule for this day.'));
    return () => ctrl.abort();
  }, [date, adminApi]);

  const valid = isValidDraft(value);
  const startIso = valid ? manilaLocalToUtcIso(`${date}T${time}`) : null;
  const ready = schedule && schedule.date === date;
  const others = ready ? schedule.entries.filter((e) => e.id !== excludeId) : [];
  const closures = ready ? schedule.closures : [];
  const range = startIso ? rangeOf(startIso, duration) : null;
  const overlaps = (e: ScheduleEntry) => {
    if (!range) return false;
    const r = rangeOf(e.startAt, e.durationMinutes);
    return r.start < range.end && r.end > range.start;
  };
  const atOnce = range ? maxOverlap(range, others.map((e) => rangeOf(e.startAt, e.durationMinutes))) + 1 : 0;
  const capacity = schedule?.capacity ?? 1;
  const dentist = byId(dentistId);
  const hasDentists = dentists.length > 0;

  // Who else could take this slot: one click to switch.
  const freeIds =
    range && ready && hasDentists
      ? freeDentists(
          {
            date,
            dentists,
            closures: asClosures(date, closures),
            bookings: others.filter((e) => e.status === 'pending' || e.status === 'confirmed').map((e) => ({ dentistId: e.dentistId, range: rangeOf(e.startAt, e.durationMinutes) })),
            capacity: Number.MAX_SAFE_INTEGER, // chairs are warned about separately
          },
          range,
        )
      : [];
  const alternatives = freeIds.filter((id) => id !== dentistId);

  const warnings: string[] = [];
  if (valid && startIso) {
    const hours = CLINIC_HOURS[weekdayOf(date)];
    const wd = WEEKDAY_NAMES[weekdayOf(date)];
    if (startIso < new Date().toISOString()) warnings.push('This time is in the past.');
    if (!hours) warnings.push(`The clinic is normally closed on ${wd}s.`);
    else if (toMinutes(time) < hours.open * 60 || toMinutes(time) + duration > hours.close * 60)
      warnings.push('This runs outside clinic hours (9:00 AM – 5:00 PM).');
    const hit = closureHit(closures, time, duration, dentistId);
    if (hit) warnings.push(`${hit.dentistId ? `${dentist?.name ?? 'This dentist'} is unavailable` : 'This overlaps a blocked time'}: ${closureLabel(hit)}.`);
    if (dentist && !worksOn(dentist, date)) warnings.push(`${dentist.name} doesn’t usually work on ${wd}s.`);
    const clash = dentist ? others.find((e) => e.dentistId === dentist.id && overlaps(e)) : undefined;
    if (clash) warnings.push(`${dentist!.name} already has ${clash.fullName} at ${formatTime(utcIsoToManilaLocal(clash.startAt).slice(11, 16))}.`);
    if (atOnce > capacity) warnings.push(`There would be ${atOnce} patients at once, but the clinic has ${capacity} chairs.`);
  }

  const durationChoices = DURATION_OPTIONS.includes(duration)
    ? DURATION_OPTIONS
    : [...DURATION_OPTIONS, duration].sort((a, b) => a - b);

  return (
    <div className="schedule-editor">
      <div className={`schedule-fields${hasDentists ? ' has-dentist' : ''}`}>
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-date`}>
            Date
          </label>
          <input id={`${uid}-date`} type="date" className="input" value={date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-time`}>
            Start
          </label>
          <input
            id={`${uid}-time`}
            type="time"
            className="input"
            step={900}
            value={time}
            onChange={(e) => onChange({ ...value, time: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-len`}>
            Length
          </label>
          <select
            id={`${uid}-len`}
            className="select"
            value={duration}
            onChange={(e) => onChange({ ...value, durationMinutes: Number(e.target.value) })}
          >
            {durationChoices.map((m) => (
              <option key={m} value={m}>
                {formatDuration(m)}
              </option>
            ))}
          </select>
        </div>
        {hasDentists && (
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-dentist`}>
              Dentist
            </label>
            <DentistSelect id={`${uid}-dentist`} value={dentistId} onChange={(id) => onChange({ ...value, dentistId: id })} />
          </div>
        )}
      </div>

      {valid && (
        <p className="schedule-summary">
          {formatDateLong(date)} ·{' '}
          <strong>
            {formatTime(time)} – {formatTime(endTime(time, duration))}
          </strong>
          {dentist && <> · {dentist.name}</>}
        </p>
      )}

      <div aria-live="polite">
        {error && <p className="field-error">{error}</p>}
        {warnings.map((w) => (
          <p key={w} className="field-hint field-warn">
            ⚠ {w} You can still save it.
          </p>
        ))}
        {hasDentists && valid && ready && (alternatives.length > 0 || dentistId === null) && (
          <div className="free-dentists">
            <span>{freeIds.length ? 'Free at this time:' : 'No dentist is free at this time.'}</span>
            {alternatives.map((id) => {
              const d = byId(id)!;
              return (
                <button key={id} type="button" className="chip-btn" onClick={() => onChange({ ...value, dentistId: id })}>
                  <span className="dentist-dot" style={{ background: d.color }} aria-hidden="true" />
                  {d.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {isDateString(date) && (
        <div className="day-schedule">
          <span className="detail-label">
            Other appointments that day · {capacity} chair{capacity === 1 ? '' : 's'}
          </span>
          {scheduleError ? (
            <p className="muted">{scheduleError}</p>
          ) : !ready ? (
            <p className="muted">Loading…</p>
          ) : others.length === 0 && closures.length === 0 ? (
            <p className="muted">None yet. This day is free.</p>
          ) : (
            <ul>
              {closures.map((c) => (
                <li key={`c${c.id}`} className={`is-blocked${valid && closureHit([c], time, duration, dentistId) ? ' is-overlap' : ''}`}>
                  <span className="day-schedule-time">
                    {c.startTime && c.endTime ? `${formatTime(c.startTime)} – ${formatTime(c.endTime)}` : 'All day'}
                  </span>
                  <span className="day-schedule-name">
                    {c.reason || 'Blocked time'}
                    {c.dentistId && ` · ${byId(c.dentistId)?.name ?? ''}`}
                  </span>
                  <span className="tag tag-muted">Blocked</span>
                </li>
              ))}
              {others.map((e) => {
                const l = utcIsoToManilaLocal(e.startAt).slice(11, 16);
                const d = byId(e.dentistId);
                // Highlight real clashes: same dentist, or any overlap when the clinic has no dentists set up.
                const clash = overlaps(e) && (!hasDentists || (dentistId !== null && e.dentistId === dentistId));
                return (
                  <li key={e.id} className={clash ? 'is-overlap' : undefined}>
                    <span className="day-schedule-time">
                      {formatTime(l)} – {formatTime(endTime(l, e.durationMinutes))}
                    </span>
                    <span className="day-schedule-name">
                      {d && <span className="dentist-dot" style={{ background: d.color }} title={d.name} aria-hidden="true" />}
                      {e.fullName}
                      {d && <span className="visually-hidden"> with {d.name}</span>}
                    </span>
                    <StatusBadge status={e.status} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Schedule fields plus a submit button, for changing an existing booking's time or dentist. */
export function ScheduleEditor({
  booking,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  booking: Booking;
  submitLabel: string;
  busy: boolean;
  error?: string;
  onSubmit: (value: ScheduleValue) => void;
  onCancel?: () => void;
}) {
  const initial = draftFromBooking(booking);
  const [draft, setDraft] = useState<SlotDraft>(initial);
  const [localError, setLocalError] = useState('');
  const changed =
    draft.date !== initial.date ||
    draft.time !== initial.time ||
    draft.durationMinutes !== initial.durationMinutes ||
    draft.dentistId !== initial.dentistId;

  return (
    <form
      className="schedule-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!isValidDraft(draft)) {
          setLocalError('Choose a valid date and time.');
          return;
        }
        onSubmit({ startAt: `${draft.date}T${draft.time}`, durationMinutes: draft.durationMinutes, dentistId: draft.dentistId });
      }}
    >
      <ScheduleFields
        value={draft}
        onChange={(d) => {
          setDraft(d);
          setLocalError('');
        }}
        excludeId={booking.id}
        error={localError || error}
      />
      <div className="action-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Keep as is
          </button>
        )}
      </div>
      {changed && booking.status === 'pending' && (
        <p className="field-hint">You changed the request, so let the patient know when you confirm.</p>
      )}
    </form>
  );
}
