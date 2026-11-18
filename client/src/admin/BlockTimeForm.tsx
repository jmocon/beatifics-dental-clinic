import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { zodFieldErrors, type ScheduleEntry } from '../../../shared/booking.ts';
import { formatDateShort, isDateString, manilaToday, utcIsoToManilaLocal, WEEKDAY_NAMES, weekdayOf } from '../../../shared/dates.ts';
import { closureSchema, describeClosure, formatTime, isTimeString, type ClosureInput, type ClosureRepeat } from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';
import { useAdminApi } from './auth.tsx';
import { useDentists } from './dentists.tsx';
import { emitBookingsChanged, type PanelContext } from './events.ts';

const REASONS = ['Lunch break', 'Holiday', 'Leave', 'Training', 'Maintenance'];

/** Block time on the calendar: a lunch break, a holiday, a day off. Shows which bookings it would affect. */
export function BlockTimeForm({ onSaved }: { onSaved?: () => void } = {}) {
  const ctx = useOutletContext<PanelContext | undefined>();
  const adminApi = useAdminApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const reasonRef = useRef<HTMLInputElement>(null);

  const qDate = params.get('date');
  const qStart = params.get('start');
  const qEnd = params.get('end');
  const [startDate, setStartDate] = useState(qDate && isDateString(qDate) ? qDate : manilaToday());
  const [endDate, setEndDate] = useState('');
  const [repeat, setRepeat] = useState<ClosureRepeat>('none');
  const [allDay, setAllDay] = useState(!(qStart && isTimeString(qStart)));
  const [startTime, setStartTime] = useState(qStart && isTimeString(qStart) ? qStart : '12:00');
  const [endTime, setEndTime] = useState(qEnd && isTimeString(qEnd) ? qEnd : '13:00');
  const [reason, setReason] = useState('');
  const dentists = useDentists();
  const [dentistId, setDentistId] = useState<number | null>(Number(params.get('dentist')) || null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [affected, setAffected] = useState<ScheduleEntry[] | null>(null);
  const [saving, setSaving] = useState(false);

  const body: ClosureInput = {
    startDate,
    endDate: endDate || null,
    repeat,
    startTime: allDay ? null : startTime,
    endTime: allDay ? null : endTime,
    reason,
    dentistId,
  };
  const parsed = closureSchema.safeParse(body);
  const bodyKey = JSON.stringify(body);

  useEffect(() => {
    document.title = 'Block time · Beatifics Admin';
    reasonRef.current?.focus();
  }, []);

  // Live preview of bookings this would cover.
  useEffect(() => {
    if (!parsed.success) {
      setAffected(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await adminApi<{ affected: ScheduleEntry[] }>('/api/admin/closures/preview', { method: 'POST', body });
        setAffected(r.affected);
      } catch {
        setAffected(null);
      }
    }, 300);
    return () => clearTimeout(t);
    // bodyKey captures every field.
  }, [bodyKey, adminApi]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await adminApi('/api/admin/closures', { method: 'POST', body });
      emitBookingsChanged();
      if (onSaved) onSaved();
      else if (ctx) {
        const d = describeClosure(parsed.data);
        const who = dentistId ? ` ${dentists.byId(dentistId)?.name ?? ''}` : '';
        navigate(ctx.backTo, { state: { flash: `Blocked${who}${reason ? ` for ${reason}` : ''}: ${d.when} · ${d.time}.` } });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        setErrors(err.fields);
      } else setFormError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const summary = parsed.success ? describeClosure(parsed.data) : null;
  const wd = isDateString(startDate) ? WEEKDAY_NAMES[weekdayOf(startDate)] : '';

  return (
    <article className="detail" aria-labelledby={id('title')}>
      {ctx && (
        <Link to={ctx.backTo} className="detail-back">
          ← Back
        </Link>
      )}
      <header className="detail-head">
        <div>
          <h2 id={id('title')}>Block time</h2>
          <p className="detail-ref">Blocked times can’t be booked online. Existing bookings stay as they are.</p>
        </div>
      </header>

      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}

      <form className="new-booking" onSubmit={submit} noValidate>
        <section className="detail-card">
          <div className="field">
            <label className="field-label" htmlFor={id('reason')}>
              Reason <span className="field-optional">Optional, shown to staff only</span>
            </label>
            <input
              ref={reasonRef}
              id={id('reason')}
              className="input"
              value={reason}
              maxLength={100}
              placeholder="e.g. Lunch break"
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="chip-row">
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`chip-btn${reason === r ? ' is-active' : ''}`}
                  onClick={() => {
                    setReason(r);
                    // Sensible defaults for common reasons, to save clicks.
                    if (r === 'Lunch break') {
                      setAllDay(false);
                      setRepeat('daily');
                      setStartTime('12:00');
                      setEndTime('13:00');
                    } else if (r === 'Holiday' || r === 'Leave') {
                      setAllDay(true);
                      setRepeat('none');
                    }
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {dentists.active.length > 0 && (
            <div className="field">
              <span className="field-label" id={id('who-label')}>
                Applies to
              </span>
              <div className="chip-row" role="radiogroup" aria-labelledby={id('who-label')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={dentistId === null}
                  className={`chip-btn${dentistId === null ? ' is-active' : ''}`}
                  onClick={() => setDentistId(null)}
                >
                  Whole clinic
                </button>
                {dentists.active.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={dentistId === d.id}
                    className={`chip-btn${dentistId === d.id ? ' is-active' : ''}`}
                    onClick={() => setDentistId(d.id)}
                  >
                    <span className="dentist-dot" style={{ background: d.color }} aria-hidden="true" />
                    {d.name} only
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <span className="field-label" id={id('repeat-label')}>
              How often
            </span>
            <div className="seg" role="radiogroup" aria-labelledby={id('repeat-label')}>
              {(
                [
                  ['none', 'Once'],
                  ['daily', 'Every day'],
                  ['weekly', wd ? `Every ${wd}` : 'Every week'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className={`seg-opt${repeat === value ? ' is-active' : ''}`}>
                  <input type="radio" name={id('repeat')} value={value} checked={repeat === value} onChange={() => setRepeat(value)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor={id('start')}>
                {repeat === 'none' ? 'Date' : 'Starting'}
              </label>
              <input id={id('start')} type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              {errors.startDate && <span className="field-error">{errors.startDate}</span>}
            </div>
            <div className="field">
              <label className="field-label" htmlFor={id('end')}>
                {repeat === 'none' ? 'Last day' : 'Until'} <span className="field-optional">{repeat === 'none' ? 'For several days' : 'Blank = no end'}</span>
              </label>
              <input
                id={id('end')}
                type="date"
                className="input"
                min={startDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-invalid={errors.endDate ? true : undefined}
              />
              {errors.endDate && <span className="field-error">{errors.endDate}</span>}
            </div>
          </div>

          <label className="switch">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            <span>All day</span>
          </label>

          {!allDay && (
            <div className="form-grid">
              <div className="field">
                <label className="field-label" htmlFor={id('from')}>
                  From
                </label>
                <input id={id('from')} type="time" step={900} className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={id('to')}>
                  To
                </label>
                <input
                  id={id('to')}
                  type="time"
                  step={900}
                  className="input"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  aria-invalid={errors.endTime || (!parsed.success && endTime <= startTime) ? true : undefined}
                />
              </div>
            </div>
          )}
          {!allDay && endTime <= startTime && <span className="field-error">The end time must be after the start time.</span>}

          {summary && (
            <p className="schedule-summary">
              <strong>{summary.when}</strong> · {summary.time}
            </p>
          )}

          {affected && affected.length > 0 && (
            <div className="alert alert-warn" role="status">
              <div>
                <strong>
                  {affected.length} booking{affected.length > 1 ? 's' : ''} fall{affected.length === 1 ? 's' : ''} in this time.
                </strong>{' '}
                They stay booked; contact the patients if they need to move.
                <ul className="affected-list">
                  {affected.slice(0, 6).map((a) => {
                    const l = utcIsoToManilaLocal(a.startAt);
                    return (
                      <li key={a.id}>
                        {ctx ? <Link to={ctx.detailHref(a.id)}>{a.fullName}</Link> : a.fullName} · {formatDateShort(l.slice(0, 10))},{' '}
                        {formatTime(l.slice(11, 16))}
                      </li>
                    );
                  })}
                  {affected.length > 6 && <li>and {affected.length - 6} more</li>}
                </ul>
              </div>
            </div>
          )}
          {affected && affected.length === 0 && <p className="muted detail-empty">No bookings are affected.</p>}
        </section>

        <div className="action-row new-booking-actions">
          <button type="submit" className="btn btn-primary btn-lg" disabled={saving}>
            {saving && <span className="spinner" aria-hidden="true" />}
            Block time
          </button>
          {ctx && (
            <Link to={ctx.backTo} className="btn btn-ghost btn-lg">
              Cancel
            </Link>
          )}
        </div>
      </form>
    </article>
  );
}
