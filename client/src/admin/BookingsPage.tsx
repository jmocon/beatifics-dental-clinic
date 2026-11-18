import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useMatch, useSearchParams } from 'react-router-dom';
import { formatPhMobile, type BookingListItem, type BookingListResponse, type BookingView } from '../../../shared/booking.ts';
import {
  formatDateLong,
  formatDateShort,
  formatDateTime,
  manilaToday,
  relativeDay,
  timeAgo,
  utcIsoToManilaLocal,
} from '../../../shared/dates.ts';
import { formatDuration, formatTime } from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';
import { useAdminApi, useAuth } from './auth.tsx';
import { DentistBadge, useDentists } from './dentists.tsx';
import { emitBookingsChanged, isTyping, useOnBookingsChanged, type PanelContext } from './events.ts';
import { StatusBadge } from './StatusBadge.tsx';

const VIEWS: { key: BookingView; label: string; empty: { title: string; body: string } }[] = [
  {
    key: 'action',
    label: 'Needs action',
    empty: { title: 'All caught up', body: 'There are no new requests waiting. New online requests will appear here with a chime.' },
  },
  {
    key: 'today',
    label: 'Today',
    empty: { title: 'No appointments today', body: 'Confirmed appointments for today will show here.' },
  },
  {
    key: 'upcoming',
    label: 'Upcoming',
    empty: { title: 'Nothing scheduled yet', body: 'Confirm a request to add it to the upcoming schedule.' },
  },
  { key: 'all', label: 'All', empty: { title: 'No bookings yet', body: 'Requests from the website will appear here.' } },
];

const REFRESH_MS = 60_000;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function BookingWhen({ b }: { b: BookingListItem }) {
  const local = utcIsoToManilaLocal(b.startAt);
  const date = local.slice(0, 10);
  const upcoming = b.status === 'pending' || b.status === 'confirmed';
  const passed = b.status === 'pending' && b.startAt < new Date().toISOString();
  return (
    <span className="row-when">
      <span>
        {formatDateShort(date)}, {formatTime(local.slice(11, 16))}
      </span>
      <span className="row-when-label">{formatDuration(b.durationMinutes)}</span>
      {passed ? (
        <span className="tag tag-warn">Time passed</span>
      ) : (
        upcoming && date >= manilaToday() && <span className="row-when-rel">{relativeDay(date)}</span>
      )}
    </span>
  );
}

/** New patient / returning / no-show history, so staff can spot them at a glance. */
export function PatientTags({ patient }: { patient: BookingListItem['patient'] }) {
  return (
    <>
      {patient.previousVisits === 0 ? (
        <span className="tag tag-new">New patient</span>
      ) : (
        <span className="tag tag-returning" title={`${patient.previousVisits} earlier booking(s)`}>
          Returning
        </span>
      )}
      {patient.noShows > 0 && (
        <span className="tag tag-warn" title="Missed appointments">
          {patient.noShows} no-show{patient.noShows > 1 ? 's' : ''}
        </span>
      )}
    </>
  );
}

export function BookingsPage() {
  const adminApi = useAdminApi();
  const { user } = useAuth();
  const dentists = useDentists();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((v) => v.key === params.get('view')) ? params.get('view') : 'action') as BookingView;
  // Dentists who sign in see their own patients first; everyone else sees all.
  const dentistParam = params.get('dentist') ?? (user?.dentistId ? String(user.dentistId) : 'all');
  const dentistQuery = dentistParam === 'all' ? '' : dentistParam;
  const [query, setQuery] = useState(params.get('q') ?? '');
  const debouncedQuery = useDebounced(query.trim(), 250);
  const searchRef = useRef<HTMLInputElement>(null);

  const [data, setData] = useState<BookingListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [justConfirmed, setJustConfirmed] = useState<number[]>([]);
  const [, forceTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const detailMatch = useMatch('/admin/bookings/:id');
  const activeId = detailMatch ? Number(detailMatch.params.id) || null : null;
  const creating = detailMatch?.params.id === 'new';

  useEffect(() => {
    document.title = 'Bookings · Beatifics Admin';
  }, []);

  // Keep the search box in the URL so links/back button keep context.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (current === debouncedQuery) return;
    const next = new URLSearchParams(params);
    if (debouncedQuery) next.set('q', debouncedQuery);
    else next.delete('q');
    setParams(next, { replace: true });
  }, [debouncedQuery, params, setParams]);

  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      if (!opts.quiet) setLoading(true);
      try {
        const qs = new URLSearchParams({ view });
        if (debouncedQuery) qs.set('q', debouncedQuery);
        if (dentistQuery) qs.set('dentist', dentistQuery);
        const res = await adminApi<BookingListResponse>(`/api/admin/bookings?${qs}`, { signal: ctrl.signal });
        setData(res);
        setError('');
        setLoadedAt(new Date());
        setJustConfirmed([]);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Couldn’t load bookings.');
      } finally {
        if (abortRef.current === ctrl) setLoading(false);
      }
    },
    [adminApi, view, debouncedQuery, dentistQuery],
  );

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => load({ quiet: true }), [load]);
  useOnBookingsChanged(refresh);

  // Fallback refresh (alerts already trigger one when patients act).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load({ quiet: true });
      forceTick((n) => n + 1);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // "/" jumps to search from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTyping(e)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const listSearch = params.toString() ? `?${params}` : '';
  const viewInfo = VIEWS.find((v) => v.key === view)!;

  const panelContext = useMemo<PanelContext>(
    () => ({
      refresh,
      backTo: `/admin${listSearch}`,
      detailHref: (id) => `/admin/bookings/${id}${listSearch}`,
      nextPendingId: (afterId) => {
        const pending = (data?.bookings ?? []).filter((b) => b.status === 'pending' && b.id !== afterId);
        if (pending.length === 0) return null;
        const all = data?.bookings ?? [];
        const idx = all.findIndex((b) => b.id === afterId);
        return (all.slice(idx + 1).find((b) => b.status === 'pending' && b.id !== afterId) ?? pending[0]).id;
      },
    }),
    [refresh, listSearch, data],
  );

  function selectView(key: BookingView) {
    const next = new URLSearchParams(params);
    next.set('view', key);
    setParams(next);
  }

  /** One-click confirm of the time the patient asked for, without opening the booking. */
  async function quickConfirm(b: BookingListItem) {
    setConfirming(b.id);
    try {
      await adminApi(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: 'confirmed' } });
      setJustConfirmed((ids) => [...ids, b.id]);
      // Let the ✓ show for a moment before the row leaves "Needs action".
      setTimeout(emitBookingsChanged, 700);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t confirm that booking.');
    } finally {
      setConfirming(null);
    }
  }

  return (
    <div className={`bookings-split${detailMatch ? ' has-detail' : ''}`}>
      <section className="bookings-list-pane" aria-labelledby="bookings-title">
        <div className="pane-head">
          <div>
            <h1 id="bookings-title">Bookings</h1>
            <p className="pane-sub">
              {formatDateLong(manilaToday())}
              <button type="button" className="refresh-btn" onClick={() => load()} disabled={loading}>
                <span className={loading ? 'spinner' : 'refresh-icon'} aria-hidden="true">
                  {loading ? '' : '↻'}
                </span>
                {loadedAt ? `Updated ${timeAgo(loadedAt.toISOString())}` : 'Refresh'}
              </button>
            </p>
          </div>
          <Link
            to={`/admin/bookings/new${listSearch}`}
            className={`btn btn-primary btn-sm new-booking-btn${creating ? ' is-active' : ''}`}
            aria-current={creating ? 'page' : undefined}
            title="Shortcut: N"
          >
            <span aria-hidden="true">+</span> New appointment
          </Link>
        </div>

        <div className="view-tabs" role="tablist" aria-label="Booking views">
          {VIEWS.map((v) => {
            const count = data?.counts[v.key];
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                className={`view-tab${view === v.key ? ' is-active' : ''}`}
                onClick={() => selectView(v.key)}
              >
                {v.label}
                {count !== undefined && (
                  <span className={`view-count${v.key === 'action' && count > 0 ? ' is-alert' : ''}`}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className={`list-filters${dentists.active.length ? ' has-dentists' : ''}`}>
        <div className="search">
          <label htmlFor="booking-search" className="visually-hidden">
            Search bookings
          </label>
          <svg className="search-icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            id="booking-search"
            className="input search-input"
            type="search"
            placeholder="Search name, mobile or reference"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            autoComplete="off"
          />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">
              ×
            </button>
          ) : (
            <kbd className="search-kbd" aria-hidden="true">
              /
            </kbd>
          )}
        </div>
        {dentists.active.length > 0 && (
          <>
            <label htmlFor="dentist-filter" className="visually-hidden">
              Show bookings for
            </label>
            <select
              id="dentist-filter"
              className="select dentist-filter"
              value={dentistParam}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.set('dentist', e.target.value);
                setParams(next);
              }}
              style={dentists.byId(Number(dentistParam)) ? { boxShadow: `inset 4px 0 0 ${dentists.byId(Number(dentistParam))!.color}` } : undefined}
            >
              <option value="all">All dentists</option>
              {dentists.active.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id === user?.dentistId ? 'My patients' : d.name}
                </option>
              ))}
              <option value="unassigned">No dentist yet</option>
            </select>
          </>
        )}
        </div>

        {error && (
          <div className="alert alert-error" role="alert">
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}>
              Try again
            </button>
          </div>
        )}

        <div className="bookings-list" role="tabpanel" aria-busy={loading} aria-label={viewInfo.label}>
          {!data && loading && (
            <ul className="booking-rows" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="booking-item skeleton">
                  <span className="sk sk-1" />
                  <span className="sk sk-2" />
                </li>
              ))}
            </ul>
          )}

          {data && data.bookings.length === 0 && (
            <div className="empty">
              <span className="empty-icon" aria-hidden="true">
                {debouncedQuery ? '?' : '✓'}
              </span>
              <h2>{debouncedQuery ? 'No matches' : viewInfo.empty.title}</h2>
              <p>
                {debouncedQuery ? `Nothing in “${viewInfo.label}” matches “${debouncedQuery}”.` : viewInfo.empty.body}
              </p>
              {debouncedQuery && view !== 'all' && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => selectView('all')}>
                  Search all bookings
                </button>
              )}
            </div>
          )}

          {data && data.bookings.length > 0 && (
            <ul className="booking-rows">
              {data.bookings.map((b) => {
                const done = justConfirmed.includes(b.id);
                return (
                  <li
                    key={b.id}
                    className={`booking-item${activeId === b.id ? ' is-active' : ''}${done ? ' is-done' : ''}`}
                  >
                    <Link
                      to={`/admin/bookings/${b.id}${listSearch}`}
                      className="booking-row"
                      aria-current={activeId === b.id ? 'page' : undefined}
                    >
                      <span className="row-main">
                        <span className="row-name">{b.fullName}</span>
                        <span className="row-service">{b.service}</span>
                        <span className="row-tags">
                          {dentists.active.length > 0 && <DentistBadge id={b.dentistId} compact />}
                          <PatientTags patient={b.patient} />
                          {b.source === 'staff' && <span className="tag tag-muted">Added by staff</span>}
                        </span>
                      </span>
                      <BookingWhen b={b} />
                      <span className="row-meta">
                        <StatusBadge status={done ? 'confirmed' : b.status} />
                        <span className="row-mobile">{formatPhMobile(b.mobile)}</span>
                        <span className="row-ago" title={formatDateTime(b.createdAt)}>
                          Requested {timeAgo(b.createdAt)}
                        </span>
                      </span>
                    </Link>
                    {b.status === 'pending' && !done && (
                      <button
                        type="button"
                        className="row-confirm"
                        disabled={confirming !== null}
                        onClick={() => quickConfirm(b)}
                        title={`Confirm ${b.fullName} for the requested time`}
                      >
                        {confirming === b.id ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">✓</span>}
                        Confirm
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="booking-detail-pane" aria-label="Booking details">
        <Outlet context={panelContext} />
      </section>
    </div>
  );
}
