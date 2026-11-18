import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ReportsResponse } from '../../../shared/booking.ts';
import { addDays, formatDateShort, manilaToday, WEEKDAY_NAMES } from '../../../shared/dates.ts';
import { formatTime, fromMinutes } from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';
import { useAdminApi } from './auth.tsx';

type PresetKey = 'this-month' | 'last-month' | 'last-30' | 'last-90' | 'this-year';

function presetRange(key: PresetKey, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const firstOfMonth = `${y}-${String(m).padStart(2, '0')}-01`;
  switch (key) {
    case 'this-month':
      return { from: firstOfMonth, to: addDays(`${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-01`, -1) };
    case 'last-month': {
      const lastDay = addDays(firstOfMonth, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
    case 'last-30':
      return { from: addDays(today, -29), to: today };
    case 'last-90':
      return { from: addDays(today, -89), to: today };
    case 'this-year':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
}

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'last-90', label: 'Last 90 days' },
  { key: 'this-year', label: 'This year' },
];

const pct = (n: number, d: number) => (d === 0 ? '–' : `${Math.round((n / d) * 100)}%`);

function StatTile({ label, value, note, hero }: { label: string; value: string | number; note?: string; hero?: boolean }) {
  return (
    <div className={`stat-tile${hero ? ' is-hero' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

/** Single-series horizontal bars with the value at the tip, hover tooltip, and a table view. */
function BarList({ title, rows, unit = 'appointments' }: { title: string; rows: Array<{ label: string; value: number }>; unit?: string }) {
  const [asTable, setAsTable] = useState(false);
  const uid = useId();
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <section className="chart-card" aria-labelledby={`${uid}-t`}>
      <div className="chart-head">
        <h3 id={`${uid}-t`}>{title}</h3>
        <button type="button" className="link-btn" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <table className="chart-table">
          <thead>
            <tr>
              <th scope="col">{title}</th>
              <th scope="col">Count</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.value}</td>
                <td>{pct(r.value, total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="bar-list">
          {rows.map((r) => (
            <li key={r.label} tabIndex={0} aria-label={`${r.label}: ${r.value} ${unit}`}>
              <span className="bar-label">{r.label}</span>
              <span className="bar-track">
                <span className="bar" style={{ width: `${(r.value / max) * 100}%` }} />
                <span className="bar-value">{r.value}</span>
              </span>
              <span className="chart-tip" role="tooltip">
                <strong>{r.label}</strong>
                {r.value} {unit} · {pct(r.value, total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Single-series columns over the day, for time of day. */
function Columns({ title, rows }: { title: string; rows: Array<{ label: string; short: string; value: number }> }) {
  const [asTable, setAsTable] = useState(false);
  const uid = useId();
  const max = Math.max(1, ...rows.map((r) => r.value));
  const peak = rows.reduce((best, r) => (r.value > best.value ? r : best), rows[0]);
  return (
    <section className="chart-card" aria-labelledby={`${uid}-t`}>
      <div className="chart-head">
        <h3 id={`${uid}-t`}>{title}</h3>
        <button type="button" className="link-btn" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <table className="chart-table">
          <thead>
            <tr>
              <th scope="col">Start time</th>
              <th scope="col">Appointments</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div className="columns" style={{ gridTemplateColumns: `repeat(${rows.length}, 1fr)` }}>
            {rows.map((r) => (
              <div key={r.label} className="column-slot" tabIndex={0} aria-label={`${r.label}: ${r.value} appointments`}>
                <span className="column-value">{r === peak && r.value > 0 ? r.value : ''}</span>
                <span className="column" style={{ height: `${(r.value / max) * 100}%` }} />
                <span className="chart-tip" role="tooltip">
                  <strong>{r.label}</strong>
                  {r.value} appointments
                </span>
              </div>
            ))}
          </div>
          <div className="columns-axis" style={{ gridTemplateColumns: `repeat(${rows.length}, 1fr)` }} aria-hidden="true">
            {rows.map((r) => (
              <span key={r.label}>{r.short}</span>
            ))}
          </div>
          {peak.value > 0 && <p className="chart-caption">Busiest start time: {peak.label}</p>}
        </>
      )}
    </section>
  );
}

export function ReportsPage() {
  const adminApi = useAdminApi();
  const [params, setParams] = useSearchParams();
  const preset = (PRESETS.some((p) => p.key === params.get('period')) ? params.get('period') : 'this-month') as PresetKey;
  const range = presetRange(preset, manilaToday());
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = 'Reports · Beatifics Admin';
  }, []);

  useEffect(() => {
    setLoading(true);
    adminApi<ReportsResponse>(`/api/admin/reports?from=${range.from}&to=${range.to}`)
      .then((r) => {
        setData(r);
        setError('');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t load reports.'))
      .finally(() => setLoading(false));
  }, [adminApi, range.from, range.to]);

  const t = data?.totals;
  const attended = t ? t.completed + t.noShows : 0;

  return (
    <div className="reports">
      <div className="pane-head">
        <div>
          <h1>Reports</h1>
          <p className="pane-sub">
            {formatDateShort(range.from)} – {formatDateShort(range.to)} {range.from.slice(0, 4)}
            {loading && <span className="spinner" aria-hidden="true" />}
          </p>
        </div>
      </div>

      <div className="view-tabs period-tabs" role="tablist" aria-label="Period">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="tab"
            aria-selected={preset === p.key}
            className={`view-tab${preset === p.key ? ' is-active' : ''}`}
            onClick={() => setParams({ period: p.key })}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {t && data && (
        <>
          <div className="stat-grid">
            <StatTile hero label="Appointments" value={t.appointments} note="Not counting cancellations" />
            <StatTile label="Online requests" value={t.requestsOnline} note={`${t.addedByStaff} added by staff`} />
            <StatTile label="Completed" value={t.completed} />
            <StatTile label="No-show rate" value={pct(t.noShows, attended)} note={`${t.noShows} of ${attended} past appointments`} />
            <StatTile label="Cancelled" value={t.cancelled} />
            <StatTile label="New patients" value={t.newPatients} note={`${t.returningPatients} returning`} />
          </div>

          {t.appointments === 0 ? (
            <div className="empty">
              <span className="empty-icon" aria-hidden="true">∅</span>
              <h2>No appointments in this period</h2>
              <p>Nothing was booked between {formatDateShort(range.from)} and {formatDateShort(range.to)}. Try another period above.</p>
            </div>
          ) : (
            <div className="chart-grid">
              {data.byDentist.some((d) => d.dentistId !== null) && (
                <BarList title="By dentist" rows={data.byDentist.filter((d) => d.count > 0 || d.dentistId !== null).map((d) => ({ label: d.name, value: d.count }))} />
              )}
              <BarList
                title="Treatments"
                rows={data.byService.filter((s) => s.count > 0).map((s) => ({ label: s.service, value: s.count }))}
              />
              <BarList
                title="Busiest days"
                rows={data.byWeekday.map((d) => ({ label: WEEKDAY_NAMES[d.weekday], value: d.count }))}
              />
              <Columns
                title="Time of day"
                rows={data.byHour.map((h) => ({
                  label: formatTime(fromMinutes(h.hour * 60)),
                  short: formatTime(fromMinutes(h.hour * 60)).replace(':00', '').replace(' ', ''),
                  value: h.count,
                }))}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
