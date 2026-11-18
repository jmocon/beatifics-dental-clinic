import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLINIC } from '../../../shared/booking.ts';
import {
  bookingWindow,
  formatDateLong,
  isClinicDay,
  isDateString,
  upcomingClinicDays,
  WEEKDAY_NAMES,
  weekdayOf,
} from '../../../shared/dates.ts';
import { formatDuration, formatTime, type AvailabilityResponse } from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';

export interface AvailabilityState {
  data: AvailabilityResponse | null;
  error: string;
  loading: boolean;
  reload: () => void;
}

/** Load free time slots. `key` changes (e.g. the chosen service) trigger a reload. */
export function useAvailability(fetcher: () => Promise<AvailabilityResponse>, key: string): AvailabilityState {
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const res = await fetcherRef.current();
      if (id === requestId.current) setData(res);
    } catch (err) {
      if (id === requestId.current) setError(err instanceof ApiError ? err.message : 'We couldn’t load available times.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, key]);

  return { data, error, loading, reload: load };
}

const DAY_CHIPS = 10;

function chipParts(date: string) {
  const [, m, d] = date.split('-').map(Number);
  const month = new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-PH', { month: 'short', timeZone: 'UTC' });
  return { weekday: WEEKDAY_NAMES[weekdayOf(date)].slice(0, 3), day: d, month };
}

/**
 * Day chips + "later date" picker, then free times grouped into morning / afternoon.
 * Fully controlled: the parent owns `date`, `time` and the error messages.
 */
export function SlotPicker({
  idPrefix,
  availability,
  date,
  time,
  onDate,
  onTime,
  errors,
  durationHint,
  offDays,
}: {
  idPrefix: string;
  availability: AvailabilityState;
  date: string;
  time: string;
  onDate: (date: string, closedDayError?: string) => void;
  onTime: (time: string) => void;
  errors: { preferredDate?: string; preferredTime?: string };
  /** e.g. 'Root Canal Treatment' to say "…take about 2 hours" */
  durationHint?: string;
  /** Weekdays the chosen dentist doesn't work, with their name for messages. */
  offDays?: { weekdays: number[]; who: string };
}) {
  const id = (n: string) => `${idPrefix}-${n}`;
  const [otherDateOpen, setOtherDateOpen] = useState(false);
  const dayChips = useMemo(() => upcomingClinicDays(DAY_CHIPS), []);
  const window_ = useMemo(() => bookingWindow(), []);
  const pickedOtherDate = date !== '' && !dayChips.includes(date);
  const slotsForDay = date ? availability.data?.days[date] : undefined;
  const isFull = (d: string) => availability.data?.days[d]?.length === 0;

  const a11y = (name: 'preferredDate' | 'preferredTime', hint?: string) => ({
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': [errors[name] ? id(`${name}-error`) : '', hint ?? ''].filter(Boolean).join(' ') || undefined,
  });
  const err = (name: 'preferredDate' | 'preferredTime') =>
    errors[name] ? (
      <span className="field-error" id={id(`${name}-error`)}>
        <span aria-hidden="true">!</span>
        {errors[name]}
      </span>
    ) : null;

  const morning = slotsForDay?.filter((t) => t < '12:00') ?? [];
  const afternoon = slotsForDay?.filter((t) => t >= '12:00') ?? [];
  const timeGroup = (label: string, times: string[]) =>
    times.length > 0 && (
      <div className="time-group">
        <span className="time-group-label">{label}</span>
        <div className="time-grid">
          {times.map((t) => (
            <label key={t} className="time-slot">
              <input type="radio" name="preferredTime" value={t} checked={time === t} onChange={() => onTime(t)} />
              <span>{formatTime(t)}</span>
            </label>
          ))}
        </div>
      </div>
    );

  const durationText = availability.data
    ? `${durationHint ? `${durationHint} appointments take` : 'Appointments are'} about ${formatDuration(availability.data.durationMinutes)}.`
    : 'Choose a day to see available times.';

  return (
    <>
      <fieldset className="field fieldset" {...a11y('preferredDate', id('date-hint'))}>
        <legend className="field-label">Day</legend>
        <span className="field-hint" id={id('date-hint')}>
          Open Monday–Thursday and Saturday. For same-day visits, please call.
        </span>
        <div className="day-chips" data-anchor="preferredDate" tabIndex={-1}>
          {dayChips.map((d) => {
            const p = chipParts(d);
            const off = !!offDays?.weekdays.includes(weekdayOf(d));
            const full = off || isFull(d);
            return (
              <label key={d} className={`day-chip${full ? ' is-full' : ''}`} title={off ? `${offDays!.who} doesn’t work on ${WEEKDAY_NAMES[weekdayOf(d)]}s` : undefined}>
                <input
                  type="radio"
                  name="preferredDate"
                  value={d}
                  checked={date === d}
                  disabled={full}
                  onChange={() => {
                    onDate(d);
                    setOtherDateOpen(false);
                  }}
                />
                <span className="day-chip-face">
                  <span className="day-chip-wd">{p.weekday}</span>
                  <span className="day-chip-d">{p.day}</span>
                  <span className="day-chip-m">{off ? 'Off' : full ? 'Full' : p.month}</span>
                </span>
                <span className="visually-hidden">
                  {formatDateLong(d)}
                  {off ? `, ${offDays!.who} is off` : full ? ', fully booked' : ''}
                </span>
              </label>
            );
          })}
          <button
            type="button"
            className={`day-chip day-chip-other${otherDateOpen || pickedOtherDate ? ' is-active' : ''}`}
            aria-expanded={otherDateOpen || pickedOtherDate}
            aria-controls={id('other-date')}
            onClick={() => {
              setOtherDateOpen(true);
              if (dayChips.includes(date)) onDate('');
              requestAnimationFrame(() => document.getElementById(id('other-date-input'))?.focus());
            }}
          >
            <span className="day-chip-face">
              <span className="day-chip-wd">Later</span>
              <span className="day-chip-plus" aria-hidden="true">
                +
              </span>
              <span className="day-chip-m">date</span>
            </span>
          </button>
        </div>
        {(otherDateOpen || pickedOtherDate) && (
          <div className="other-date" id={id('other-date')}>
            <label className="field-label" htmlFor={id('other-date-input')}>
              Choose another date
            </label>
            <input
              id={id('other-date-input')}
              type="date"
              className="input"
              min={window_.first}
              max={window_.last}
              value={pickedOtherDate ? date : ''}
              onChange={(e) => {
                const d = e.target.value;
                const closed =
                  d && isDateString(d) && !isClinicDay(d)
                    ? `We’re closed on ${WEEKDAY_NAMES[weekdayOf(d)]}s. Please choose Monday–Thursday or Saturday.`
                    : d && isDateString(d) && offDays?.weekdays.includes(weekdayOf(d))
                      ? `${offDays.who} doesn’t work on ${WEEKDAY_NAMES[weekdayOf(d)]}s. Please choose another day or “Any dentist”.`
                      : undefined;
                onDate(d, closed);
              }}
              {...a11y('preferredDate')}
            />
          </div>
        )}
        {err('preferredDate')}
      </fieldset>

      <fieldset className="field fieldset" {...a11y('preferredTime', id('time-hint'))}>
        <legend className="field-label">Time</legend>
        <span className="field-hint" id={id('time-hint')}>
          {durationText}
        </span>
        <div className="time-slots" data-anchor="preferredTime" tabIndex={-1} aria-live="polite" aria-busy={availability.loading}>
          {availability.error ? (
            <div className="alert alert-error">
              <span>
                {availability.error} Please try again, or call <a href={CLINIC.phoneHref}>{CLINIC.phoneDisplay}</a>.
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={availability.reload}>
                Try again
              </button>
            </div>
          ) : !date ? (
            <p className="time-empty">Pick a day above to see open times.</p>
          ) : !isClinicDay(date) ? null : availability.loading && !availability.data ? (
            <p className="time-empty">
              <span className="spinner" aria-hidden="true" /> Loading available times…
            </p>
          ) : slotsForDay === undefined ? (
            <p className="time-empty">This date can’t be booked online. Please choose another day or call us.</p>
          ) : slotsForDay.length === 0 ? (
            <p className="time-empty">
              {offDays?.weekdays.includes(weekdayOf(date))
                ? `${offDays.who} doesn’t work on ${WEEKDAY_NAMES[weekdayOf(date)]}s. Please choose another day or “Any dentist”.`
                : `${formatDateLong(date)} is fully booked. Please choose another day, or call ${CLINIC.phoneDisplay} and we’ll try to fit you in.`}
            </p>
          ) : (
            <>
              {timeGroup('Morning', morning)}
              {timeGroup('Afternoon', afternoon)}
            </>
          )}
        </div>
        {err('preferredTime')}
      </fieldset>
    </>
  );
}

/** Focus the first invalid control in a form, including the custom day/time groups. */
export function focusField(form: HTMLFormElement | null, name: string) {
  if (!form) return;
  const target =
    name === 'preferredDate' || name === 'preferredTime'
      ? (form.querySelector<HTMLElement>(`input[name="${name}"]:checked, input[name="${name}"]:not(:disabled)`) ??
        form.querySelector<HTMLElement>(`[data-anchor="${name}"]`))
      : form.querySelector<HTMLElement>(`[name="${name}"]`);
  target?.focus();
}
