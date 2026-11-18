import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useMatch, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { STATUS_LABELS, type ScheduleEntry } from '../../../shared/booking.ts';
import {
  addDays,
  CLINIC_HOURS,
  formatDateLong,
  formatDateShort,
  isDateString,
  manilaHour,
  manilaToday,
  utcIsoToManilaLocal,
  WEEKDAY_NAMES,
  weekdayOf,
} from '../../../shared/dates.ts';
import { worksOn, type Dentist } from '../../../shared/dentists.ts';
import {
  closureAppliesOn,
  describeClosure,
  formatDuration,
  formatTime,
  fromMinutes,
  layoutLanes,
  toMinutes,
  type Closure,
} from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';
import { useAdminApi, useAuth } from './auth.tsx';
import { useDentists } from './dentists.tsx';
import { emitBookingsChanged, isTyping, useOnBookingsChanged, type PanelContext } from './events.ts';
import { StatusBadge } from './StatusBadge.tsx';

interface CalendarResponse {
  from: string;
  to: string;
  capacity: number;
  entries: ScheduleEntry[];
  closures: Closure[];
}

export interface CalendarPanelContext extends PanelContext {
  date: string;
  dayEntries: ScheduleEntry[];
  dayClosures: Closure[];
}

const PX_PER_MIN = 1.3;
const SNAP_MIN = 15;

/** Monday of the week containing `date`. */
function weekStart(date: string): string {
  const wd = weekdayOf(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

const localOf = (iso: string) => utcIsoToManilaLocal(iso);
const minutesOf = (iso: string) => toMinutes(localOf(iso).slice(11, 16));
const dateOf = (iso: string) => localOf(iso).slice(0, 10);

/** One column of the day view: a dentist, "no dentist yet", or (no dentists set up) the whole clinic. */
interface Column {
  key: string;
  dentist: Dentist | null;
  label: string;
  color: string | null;
  offToday: boolean;
  entries: ScheduleEntry[];
  closures: Closure[];
}

export function CalendarPage() {
  const adminApi = useAdminApi();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const dentists = useDentists();
  const [params, setParams] = useSearchParams();
  const today = manilaToday();
  const date = isDateString(params.get('date') ?? '') ? params.get('date')! : today;
  const week = weekStart(date);
  // Dentists who sign in see their own column first; one click shows everyone.
  const focus = params.get('show') ?? (user?.dentistId ? String(user.dentistId) : 'all');
  const focusId = focus === 'all' ? null : Number(focus) || null;
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<{ col: string; min: number } | null>(null);
  const [closureMenu, setClosureMenu] = useState<{ closure: Closure; col: string; x: number; y: number } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const gridRef = useRef<HTMLDivElement>(null);

  const panelMatch = useMatch('/admin/calendar/:panel');
  const activeId = panelMatch ? Number(panelMatch.params.panel) || null : null;

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      next.set(key, value);
      setParams(next);
    },
    [params, setParams],
  );
  const goto = useCallback((d: string) => setParam('date', d), [setParam]);
  // Keep the day and column filter when moving between panels.
  const qs = `?date=${date}${params.get('show') ? `&show=${params.get('show')}` : ''}`;

  const load = useCallback(async () => {
    try {
      const r = await adminApi<CalendarResponse>(`/api/admin/calendar?from=${week}&to=${addDays(week, 6)}`);
      setData(r);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load the calendar.');
    }
  }, [adminApi, week]);

  useEffect(() => {
    load();
  }, [load]);
  useOnBookingsChanged(load);

  useEffect(() => {
    document.title = `Calendar · ${formatDateShort(date)} · Beatifics Admin`;
  }, [date]);

  // Keep the "now" line moving.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // ← / → change day, T jumps to today.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      if (e.key === 'ArrowLeft') goto(addDays(date, -1));
      else if (e.key === 'ArrowRight') goto(addDays(date, 1));
      else if (e.key.toLowerCase() === 't') goto(today);
      else if (e.key === 'Escape') setClosureMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [date, goto, today]);

  const hasDentists = dentists.active.length > 0;
  const inFocus = useCallback((e: { dentistId: number | null }) => focusId === null || e.dentistId === focusId, [focusId]);
  const dayEntries = useMemo(() => (data?.entries ?? []).filter((e) => dateOf(e.startAt) === date), [data, date]);
  const dayClosures = useMemo(() => (data?.closures ?? []).filter((c) => closureAppliesOn(c, date)), [data, date]);
  const clinicClosures = dayClosures.filter((c) => c.dentistId === null);
  const hours = CLINIC_HOURS[weekdayOf(date)];
  const wholeDayClosed = clinicClosures.find((c) => !c.startTime);

  // Columns: each dentist working today (or with bookings today), plus "no dentist yet" when needed.
  const columns: Column[] = useMemo(() => {
    if (!hasDentists) {
      return [{ key: 'all', dentist: null, label: '', color: null, offToday: !hours, entries: dayEntries, closures: dayClosures }];
    }
    const activeIds = new Set(dentists.active.map((d) => d.id));
    const cols: Column[] = dentists.active
      .filter((d) => (focusId === null || d.id === focusId) && (worksOn(d, date) || dayEntries.some((e) => e.dentistId === d.id)))
      .map((d) => ({
        key: String(d.id),
        dentist: d,
        label: d.name,
        color: d.color,
        offToday: !worksOn(d, date) || !hours,
        entries: dayEntries.filter((e) => e.dentistId === d.id),
        closures: dayClosures.filter((c) => c.dentistId === null || c.dentistId === d.id),
      }));
    const unassigned = dayEntries.filter((e) => e.dentistId === null || !activeIds.has(e.dentistId));
    if (focusId === null && unassigned.length > 0) {
      cols.push({ key: 'none', dentist: null, label: 'No dentist yet', color: null, offToday: false, entries: unassigned, closures: clinicClosures });
    }
    return cols;
  }, [hasDentists, dentists.active, focusId, date, dayEntries, dayClosures, clinicClosures, hours]);

  // Visible range: clinic hours with a little air, stretched to fit anything booked outside them.
  const open = (hours?.open ?? 9) * 60;
  const close = (hours?.close ?? 17) * 60;
  const startMin = Math.min(open - 30, ...dayEntries.map((e) => minutesOf(e.startAt)));
  const endMin = Math.max(close + 30, ...dayEntries.map((e) => minutesOf(e.startAt) + e.durationMinutes));
  const viewStart = Math.floor(startMin / 60) * 60;
  const viewEnd = Math.ceil(endMin / 60) * 60;
  const height = (viewEnd - viewStart) * PX_PER_MIN;
  const y = (min: number) => (min - viewStart) * PX_PER_MIN;

  const panelContext = useMemo<CalendarPanelContext>(
    () => ({
      refresh: load,
      backTo: `/admin/calendar${qs}`,
      detailHref: (id) => `/admin/calendar/${id}${qs}`,
      blockHref: (d, t, dentistId) =>
        `/admin/calendar/block?date=${d}&start=${t}&end=${fromMinutes(Math.min(toMinutes(t) + 60, 24 * 60 - 1))}${dentistId ? `&dentist=${dentistId}` : ''}`,
      date,
      dayEntries,
      dayClosures,
    }),
    [load, qs, date, dayEntries, dayClosures],
  );

  function minuteAt(el: HTMLElement, clientY: number): number {
    const rect = el.getBoundingClientRect();
    const m = viewStart + (clientY - rect.top) / PX_PER_MIN;
    return Math.max(viewStart, Math.min(viewEnd - SNAP_MIN, Math.floor(m / SNAP_MIN) * SNAP_MIN));
  }

  async function removeClosure(c: Closure) {
    try {
      await adminApi(`/api/admin/closures/${c.id}`, { method: 'DELETE' });
      setClosureMenu(null);
      emitBookingsChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t remove that blocked time.');
    }
  }

  const nowMin = date === manilaToday(now) ? manilaHour(now) * 60 + now.getUTCMinutes() : null;
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const flash = (location.state as { flash?: string } | null)?.flash;
  const focusDentist = dentists.byId(focusId);
  const newHref = `/admin/calendar/new${qs}&time=${fromMinutes(Math.max(open, nowMin ? Math.ceil(nowMin / 30) * 30 : open))}${
    focusId ? `&dentist=${focusId}` : ''
  }`;

  return (
    <div className={`bookings-split calendar-split${panelMatch ? ' has-detail' : ''}`}>
      <section className="bookings-list-pane calendar-pane" aria-labelledby="cal-title">
        <div className="cal-toolbar">
          <div className="cal-nav">
            <button type="button" className="icon-btn" onClick={() => goto(addDays(date, -1))} aria-label="Previous day" title="Previous day (←)">
              ‹
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => goto(today)} disabled={date === today} title="Today (T)">
              Today
            </button>
            <button type="button" className="icon-btn" onClick={() => goto(addDays(date, 1))} aria-label="Next day" title="Next day (→)">
              ›
            </button>
            <label className="cal-date-pick" title="Jump to a date">
              <span className="visually-hidden">Jump to date</span>
              <input type="date" value={date} onChange={(e) => isDateString(e.target.value) && goto(e.target.value)} />
            </label>
          </div>
          <div className="action-row">
            <Link to={`/admin/calendar/block${qs}${focusId ? `&dentist=${focusId}` : ''}`} className="btn btn-secondary btn-sm">
              Block time
            </Link>
            <Link to={newHref} className="btn btn-primary btn-sm" title="Shortcut: N">
              <span aria-hidden="true">+</span> New appointment
            </Link>
          </div>
        </div>

        <h1 id="cal-title" className="cal-title">
          {formatDateLong(date)}
          {date === today && <span className="tag tag-new">Today</span>}
        </h1>

        {hasDentists && (
          <div className="dentist-tabs" role="tablist" aria-label="Show dentist">
            <button type="button" role="tab" aria-selected={focusId === null} className={`chip-btn${focusId === null ? ' is-active' : ''}`} onClick={() => setParam('show', 'all')}>
              All dentists
            </button>
            {dentists.active.map((d) => (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={focusId === d.id}
                className={`chip-btn${focusId === d.id ? ' is-active' : ''}`}
                onClick={() => setParam('show', String(d.id))}
              >
                <span className="dentist-dot" style={{ background: d.color }} aria-hidden="true" />
                {d.id === user?.dentistId ? `Me (${d.name})` : d.name}
              </button>
            ))}
          </div>
        )}

        <div className="week-strip" role="tablist" aria-label="Days this week">
          {weekDays.map((d) => {
            const count = (data?.entries ?? []).filter((e) => dateOf(e.startAt) === d && e.status !== 'no_show' && inFocus(e)).length;
            const clinicClosed = !CLINIC_HOURS[weekdayOf(d)] || (data?.closures ?? []).some((c) => c.dentistId === null && !c.startTime && closureAppliesOn(c, d));
            const dentistOff = focusDentist && !worksOn(focusDentist, d);
            const closedAllDay = clinicClosed || !!dentistOff;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={d === date}
                className={`week-day${d === date ? ' is-active' : ''}${d === today ? ' is-today' : ''}${closedAllDay ? ' is-closed' : ''}`}
                onClick={() => goto(d)}
              >
                <span className="week-day-wd">{WEEKDAY_NAMES[weekdayOf(d)].slice(0, 3)}</span>
                <span className="week-day-d">{Number(d.slice(8))}</span>
                <span className="week-day-count">
                  {closedAllDay && count === 0 ? (clinicClosed ? 'Closed' : 'Off') : count ? `${count} appt${count > 1 ? 's' : ''}` : '—'}
                </span>
              </button>
            );
          })}
        </div>

        {flash && !panelMatch && (
          <div className="alert alert-success" role="status">
            ✓ {flash}
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {(!hours || wholeDayClosed) && (
          <div className="alert alert-warn">
            <span>
              {wholeDayClosed
                ? `Blocked all day${wholeDayClosed.reason ? `: ${wholeDayClosed.reason}` : ''}. Patients can’t book online.`
                : `The clinic is normally closed on ${WEEKDAY_NAMES[weekdayOf(date)]}s. You can still add an appointment here.`}
            </span>
          </div>
        )}
        {hasDentists && columns.length === 0 && (
          <div className="alert alert-info">
            <span>{focusDentist ? `${focusDentist.name} doesn’t work on ${WEEKDAY_NAMES[weekdayOf(date)]}s.` : 'No dentists work on this day.'}</span>
            {focusDentist && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setParam('show', 'all')}>
                Show all dentists
              </button>
            )}
          </div>
        )}

        {columns.length > 0 && (
          <div className="timeline" aria-label={`Schedule for ${formatDateLong(date)}`}>
            <div className="timeline-hours" aria-hidden="true" style={{ height, marginTop: hasDentists ? 34 : 0 }}>
              {Array.from({ length: (viewEnd - viewStart) / 60 + 1 }, (_, i) => viewStart + i * 60).map((m) => (
                <span key={m} style={{ top: y(m) }}>
                  {formatTime(fromMinutes(Math.min(m, 23 * 60 + 59))).replace(':00', '')}
                </span>
              ))}
            </div>
            <div className="timeline-cols" ref={gridRef} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(${columns.length > 2 ? 130 : 0}px, 1fr))` }}>
              {columns.map((col) => {
                const laid = layoutLanes(
                  col.entries.map((e) => {
                    const s = minutesOf(e.startAt);
                    return { ...e, start: s, end: s + e.durationMinutes };
                  }),
                );
                const colDentistParam = col.dentist ? `&dentist=${col.dentist.id}` : '';
                return (
                  <div key={col.key} className="timeline-col">
                    {hasDentists && (
                      <div className="col-head" style={col.color ? { boxShadow: `inset 0 3px 0 ${col.color}` } : undefined}>
                        {col.color && <span className="dentist-dot" style={{ background: col.color }} aria-hidden="true" />}
                        <span className="col-head-name">{col.label}</span>
                        <span className="col-head-count">{col.entries.filter((e) => e.status !== 'no_show').length || ''}</span>
                      </div>
                    )}
                    <div
                      className={`timeline-grid${col.offToday ? ' is-off' : ''}`}
                      style={{ height, backgroundSize: `100% ${30 * PX_PER_MIN}px` }}
                      onMouseMove={(e) => {
                        if ((e.target as HTMLElement).closest('.cal-block, .cal-closure, .closure-menu')) setHover(null);
                        else setHover({ col: col.key, min: minuteAt(e.currentTarget, e.clientY) });
                      }}
                      onMouseLeave={() => setHover(null)}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('.cal-block, .cal-closure, .closure-menu')) return;
                        const m = minuteAt(e.currentTarget, e.clientY);
                        navigate(`/admin/calendar/new${qs}&time=${fromMinutes(Math.floor(m / 15) * 15)}${colDentistParam}`);
                      }}
                    >
                      {/* Outside clinic hours, or the dentist's day off */}
                      {hours && !col.offToday ? (
                        <>
                          <div className="timeline-off" style={{ top: 0, height: y(open) }} />
                          <div className="timeline-off" style={{ top: y(close), height: height - y(close) }} />
                        </>
                      ) : (
                        <div className="timeline-off is-day-off" style={{ top: 0, height }}>
                          {col.dentist && hours && <span>Day off</span>}
                        </div>
                      )}

                      {col.closures.map((c) => {
                        const s = c.startTime ? toMinutes(c.startTime) : viewStart;
                        const e = c.endTime ? toMinutes(c.endTime) : viewEnd;
                        const d = describeClosure(c);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            className="cal-closure"
                            style={{ top: y(Math.max(s, viewStart)), height: Math.max(18, (Math.min(e, viewEnd) - Math.max(s, viewStart)) * PX_PER_MIN) }}
                            onClick={(ev) => {
                              const rect = (ev.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                              setClosureMenu({ closure: c, col: col.key, x: ev.clientX - rect.left, y: ev.clientY - rect.top });
                            }}
                            title={`${c.reason || 'Blocked'} · ${d.time} · ${d.when}`}
                          >
                            <span>{c.reason || 'Blocked'}</span>
                            <small>{d.time}</small>
                          </button>
                        );
                      })}

                      {hover?.col === col.key && (
                        <div className="timeline-hover" style={{ top: y(hover.min), height: 30 * PX_PER_MIN }} aria-hidden="true">
                          + {formatTime(fromMinutes(hover.min))}
                        </div>
                      )}

                      {laid.map((e) => {
                        const top = y(e.start);
                        const h = Math.max(22, e.durationMinutes * PX_PER_MIN - 2);
                        const width = 100 / e.lanes;
                        return (
                          <Link
                            key={e.id}
                            to={`/admin/calendar/${e.id}${qs}`}
                            className={`cal-block cal-${e.status}${activeId === e.id ? ' is-active' : ''}${h < 44 ? ' is-short' : ''}`}
                            style={{ top, height: h, left: `calc(${e.lane * width}% + 2px)`, width: `calc(${width}% - 4px)` }}
                            title={`${e.fullName} · ${formatTime(fromMinutes(e.start))}–${formatTime(fromMinutes(e.end))} · ${e.service} · ${STATUS_LABELS[e.status]}`}
                          >
                            <span className="cal-block-time">
                              {formatTime(fromMinutes(e.start))} – {formatTime(fromMinutes(e.end))}
                            </span>
                            <span className="cal-block-name">{e.fullName}</span>
                            {h >= 60 && <span className="cal-block-service">{e.service}</span>}
                            {/* Narrow blocks: the amber dashed style already says "pending". */}
                            {e.status === 'pending' && e.lanes === 1 && columns.length <= 2 && <span className="cal-block-flag">Pending</span>}
                          </Link>
                        );
                      })}

                      {nowMin !== null && nowMin >= viewStart && nowMin <= viewEnd && (
                        <div className="timeline-now" style={{ top: y(nowMin) }} aria-hidden="true" />
                      )}

                      {closureMenu?.col === col.key && (
                        <div className="closure-menu" style={{ left: Math.min(closureMenu.x, 120), top: closureMenu.y }} role="dialog" aria-label="Blocked time">
                          <strong>{closureMenu.closure.reason || 'Blocked time'}</strong>
                          <span>
                            {describeClosure(closureMenu.closure).time} · {describeClosure(closureMenu.closure).when}
                            {closureMenu.closure.dentistId && ` · ${dentists.byId(closureMenu.closure.dentistId)?.name ?? ''}`}
                          </span>
                          <div className="action-row">
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => removeClosure(closureMenu.closure)} autoFocus>
                              Remove block
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClosureMenu(null)}>
                              Close
                            </button>
                          </div>
                          {closureMenu.closure.repeat !== 'none' && <small className="muted">Removes every repeat.</small>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <p className="muted cal-hint">
          Click an empty time{hasDentists ? ' in a dentist’s column' : ''} to add an appointment · <kbd>←</kbd> <kbd>→</kbd> change day · <kbd>T</kbd> today
        </p>
      </section>

      <section className="booking-detail-pane" aria-label="Details">
        <Outlet context={panelContext} />
      </section>
    </div>
  );
}

/** Right-hand panel when nothing is selected: the day's agenda. */
export function CalendarDaySummary() {
  const { date, dayEntries, dayClosures, detailHref } = useOutletContext<CalendarPanelContext>();
  const dentists = useDentists();
  const active = dayEntries.filter((e) => e.status === 'pending' || e.status === 'confirmed');
  const pending = active.filter((e) => e.status === 'pending').length;
  const booked = active.reduce((sum, e) => sum + e.durationMinutes, 0);

  return (
    <div className="detail">
      <div className="detail-card">
        <h3 className="detail-card-title">{formatDateLong(date)}</h3>
        <p className="day-summary-line">
          <strong>{active.length}</strong> appointment{active.length === 1 ? '' : 's'}
          {pending > 0 && <span className="tag tag-warn">{pending} pending</span>}
          {booked > 0 && <span className="muted"> · {formatDuration(booked)} booked</span>}
        </p>
        {dentists.active.length > 0 && (
          <ul className="dentist-day-list">
            {dentists.active.map((d) => {
              const n = active.filter((e) => e.dentistId === d.id).length;
              return (
                <li key={d.id} className={worksOn(d, date) ? undefined : 'is-off'}>
                  <span className="dentist-dot" style={{ background: d.color }} aria-hidden="true" />
                  <span>{d.name}</span>
                  <span className="muted">{worksOn(d, date) ? `${n} appointment${n === 1 ? '' : 's'}` : 'Day off'}</span>
                </li>
              );
            })}
          </ul>
        )}
        {dayClosures.length > 0 && (
          <ul className="history-list">
            {dayClosures.map((c) => (
              <li key={`c${c.id}`} className="is-blocked">
                <span className="history-row">
                  <span className="history-date">{describeClosure(c).time}</span>
                  <span className="history-service">
                    {c.reason || 'Blocked time'}
                    {c.dentistId && ` · ${dentists.byId(c.dentistId)?.name ?? ''}`}
                  </span>
                  <span className="tag tag-muted">Blocked</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {dayEntries.length === 0 ? (
          <p className="muted detail-empty">Nothing booked. Click an empty time on the calendar to add an appointment.</p>
        ) : (
          <ul className="history-list">
            {dayEntries.map((e) => {
              const d = dentists.byId(e.dentistId);
              return (
                <li key={e.id}>
                  <Link to={detailHref(e.id)}>
                    <span className="history-date">{formatTime(localOf(e.startAt).slice(11, 16))}</span>
                    <span className="history-service">
                      {d && <span className="dentist-dot" style={{ background: d.color }} title={d.name} aria-hidden="true" />}
                      <strong>{e.fullName}</strong> · {e.service}
                    </span>
                    <StatusBadge status={e.status} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="muted shortcut-hint">
        Shortcuts: <kbd>N</kbd> new appointment · <kbd>←</kbd>/<kbd>→</kbd> change day · <kbd>T</kbd> today
      </p>
    </div>
  );
}
