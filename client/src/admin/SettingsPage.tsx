import { useCallback, useEffect, useId, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import {
  newUserSchema,
  PASSWORD_MIN,
  ROLE_HINTS,
  ROLE_LABELS,
  ROLES,
  SERVICES,
  zodFieldErrors,
  type AuditEntry,
  type Role,
  type Service,
  type StaffAccount,
} from '../../../shared/booking.ts';
import { formatDateTime, manilaToday, timeAgo } from '../../../shared/dates.ts';
import {
  dailySlots,
  describeClosure,
  DURATION_OPTIONS,
  formatDuration,
  formatTime,
  MAX_CAPACITY,
  type ClinicSettings,
  type Closure,
} from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';
import { useAdminApi, useAuth } from './auth.tsx';
import { BlockTimeForm } from './BlockTimeForm.tsx';
import { DentistBadge, useDentists } from './dentists.tsx';
import { CLINIC_HOURS } from '../../../shared/dates.ts';
import { describeWorkingDays, WEEKDAY_SHORT, type Dentist } from '../../../shared/dentists.ts';
import { emitBookingsChanged, useOnBookingsChanged } from './events.ts';

// Any regular weekday works for previewing how many start times patients will see.
const SAMPLE_DAY = '2026-01-05'; // a Monday

function useFlash(): [string, (msg: string) => void] {
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 4000);
    return () => clearTimeout(t);
  }, [flash]);
  return [flash, setFlash];
}

function Flash({ message }: { message: string }) {
  return (
    <div className="flash" role="status" aria-live="polite">
      {message && <div className="alert alert-success">✓ {message}</div>}
    </div>
  );
}

export function SettingsLayout() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const tabs = [
    { to: '/admin/settings', label: 'General', end: true },
    { to: '/admin/settings/dentists', label: 'Dentists' },
    { to: '/admin/settings/blocked', label: 'Blocked times' },
    ...(isAdmin ? [{ to: '/admin/settings/staff', label: 'Staff' }, { to: '/admin/settings/activity', label: 'Activity' }] : []),
    { to: '/admin/settings/account', label: 'My account' },
  ];
  return (
    <div className="settings">
      <div className="pane-head">
        <div>
          <h1>Settings</h1>
          <p className="pane-sub">How booking works, who can sign in, and your account.</p>
        </div>
      </div>
      <nav className="sub-tabs" aria-label="Settings sections">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `sub-tab${isActive ? ' is-active' : ''}`}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

// ---------- General ----------

export function GeneralSettings() {
  const adminApi = useAdminApi();
  const { user } = useAuth();
  const canEdit = user?.role === 'admin';
  const uid = useId();
  const [saved, setSaved] = useState<ClinicSettings | null>(null);
  const [form, setForm] = useState<ClinicSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useFlash();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Settings · Beatifics Admin';
    adminApi<{ settings: ClinicSettings }>('/api/admin/settings')
      .then((r) => {
        setSaved(r.settings);
        setForm(r.settings);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Couldn’t load settings.'));
  }, [adminApi]);

  if (loadError) return <div className="alert alert-error">{loadError}</div>;
  if (!form || !saved) return <div className="detail-skeleton"><span className="sk sk-1" /><span className="sk sk-2" /></div>;

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const slots = dailySlots(SAMPLE_DAY, form.appointmentMinutes);
  const setCapacity = (n: number) => setForm({ ...form, capacity: Math.min(MAX_CAPACITY, Math.max(1, n)) });
  const setServiceLength = (s: Service, minutes: number | null) => {
    const next = { ...form.serviceMinutes };
    if (minutes === null) delete next[s];
    else next[s] = minutes;
    setForm({ ...form, serviceMinutes: next });
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError('');
    try {
      const r = await adminApi<{ settings: ClinicSettings }>('/api/admin/settings', { method: 'PUT', body: form });
      setSaved(r.settings);
      setForm(r.settings);
      setFlash('Settings saved. New online requests will use them.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Flash message={flash} />
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {!canEdit && <div className="alert alert-info">Only an admin can change these settings.</div>}

      <form className="detail-card settings-form" onSubmit={save}>
        <fieldset className="settings-fieldset" disabled={!canEdit}>
          <div className="setting">
            <div className="setting-text">
              <label className="setting-title" htmlFor={`${uid}-len`}>
                Time per patient
              </label>
              <p>The default length of an online booking. Treatments below can be set longer or shorter.</p>
            </div>
            <select
              id={`${uid}-len`}
              className="select setting-control"
              value={form.appointmentMinutes}
              onChange={(e) => setForm({ ...form, appointmentMinutes: Number(e.target.value) })}
            >
              {DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {formatDuration(m)}
                </option>
              ))}
            </select>
          </div>

          <div className="setting">
            <div className="setting-text">
              <span className="setting-title" id={`${uid}-cap-label`}>
                Patients at the same time
              </span>
              <p>
                How many patients the clinic can see at once (chairs). Each dentist also sees only one patient at a time, so
                a time stops showing online when the chairs or the dentists are all busy.
              </p>
            </div>
            <div className="stepper setting-control" role="group" aria-labelledby={`${uid}-cap-label`}>
              <button type="button" className="stepper-btn" onClick={() => setCapacity(form.capacity - 1)} disabled={form.capacity <= 1} aria-label="One fewer patient">
                −
              </button>
              <input
                className="stepper-value"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_CAPACITY}
                value={form.capacity}
                onChange={(e) => setCapacity(Number(e.target.value) || 1)}
                aria-labelledby={`${uid}-cap-label`}
              />
              <button type="button" className="stepper-btn" onClick={() => setCapacity(form.capacity + 1)} disabled={form.capacity >= MAX_CAPACITY} aria-label="One more patient">
                +
              </button>
            </div>
          </div>

          <div className="setting setting-block">
            <div className="setting-text">
              <span className="setting-title">Length per treatment</span>
              <p>So a root canal reserves enough time automatically. “Default” uses the time per patient above.</p>
            </div>
            <ul className="service-lengths">
              {SERVICES.map((s) => {
                const value = form.serviceMinutes[s];
                return (
                  <li key={s}>
                    <label htmlFor={`${uid}-svc-${s}`}>{s}</label>
                    <select
                      id={`${uid}-svc-${s}`}
                      className={`select select-sm${value ? ' is-custom' : ''}`}
                      value={value ?? ''}
                      onChange={(e) => setServiceLength(s, e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">Default ({formatDuration(form.appointmentMinutes)})</option>
                      {DURATION_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {formatDuration(m)}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </div>
        </fieldset>

        <div className="settings-preview">
          <span className="detail-label">What patients will see</span>
          <p>
            On a normal clinic day, patients can pick from <strong>{slots.length} start times</strong> ({formatTime(slots[0])} to{' '}
            {formatTime(slots[slots.length - 1])}, every 30 minutes) for a standard visit. Up to <strong>{form.capacity}</strong>{' '}
            {form.capacity === 1 ? 'patient' : 'patients'} can be booked at the same time.
          </p>
          <p className="muted">Existing bookings keep their current length.</p>
        </div>

        {canEdit && (
          <div className="action-row">
            <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>
              {saving && <span className="spinner" aria-hidden="true" />}
              Save settings
            </button>
            {dirty && (
              <button type="button" className="btn btn-ghost" onClick={() => setForm(saved)}>
                Discard changes
              </button>
            )}
          </div>
        )}
      </form>
    </>
  );
}

// ---------- Dentists ----------

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function DayToggles({
  days,
  onToggle,
  disabled,
  label,
}: {
  days: number[];
  onToggle: (day: number) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="day-toggles" role="group" aria-label={label}>
      {DAY_ORDER.map((d) => (
        <button
          key={d}
          type="button"
          className={`day-toggle${days.includes(d) ? ' is-on' : ''}${!CLINIC_HOURS[d] ? ' is-closed-day' : ''}`}
          aria-pressed={days.includes(d)}
          disabled={disabled}
          onClick={() => onToggle(d)}
          title={!CLINIC_HOURS[d] ? 'The clinic is normally closed this day' : undefined}
        >
          {WEEKDAY_SHORT[d]}
        </button>
      ))}
    </div>
  );
}

const toggleDay = (days: number[], d: number) => (days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);

export function DentistsSettings() {
  const adminApi = useAdminApi();
  const { user } = useAuth();
  const canEdit = user?.role === 'admin';
  const dentists = useDentists();
  const uid = useId();
  const [accounts, setAccounts] = useState<StaffAccount[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useFlash();
  const [busy, setBusy] = useState<number | 'new' | 'assign' | null>(null);
  const [newName, setNewName] = useState('');
  const [newDays, setNewDays] = useState<number[]>([1, 2, 4, 5, 6]);
  const [newUser, setNewUser] = useState<number | null>(null);
  const [nameDrafts, setNameDrafts] = useState<Record<number, string>>({});

  useEffect(() => {
    document.title = 'Dentists · Beatifics Admin';
    if (canEdit) adminApi<{ users: StaffAccount[] }>('/api/admin/users').then((r) => setAccounts(r.users)).catch(() => {});
  }, [adminApi, canEdit]);

  async function patch(d: Dentist, body: Record<string, unknown>, msg: string) {
    setBusy(d.id);
    setError('');
    try {
      await adminApi(`/api/admin/dentists/${d.id}`, { method: 'PATCH', body });
      setFlash(msg);
      dentists.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save that change.');
    } finally {
      setBusy(null);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy('new');
    setError('');
    try {
      const r = await adminApi<{ dentist: Dentist }>('/api/admin/dentists', {
        method: 'POST',
        body: { name: newName, workingDays: newDays, userId: newUser },
      });
      setFlash(`${r.dentist.name} added.`);
      setNewName('');
      setNewUser(null);
      dentists.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t add the dentist.');
    } finally {
      setBusy(null);
    }
  }

  async function autoAssign() {
    setBusy('assign');
    try {
      const r = await adminApi<{ assigned: number; left: number }>('/api/admin/dentists/auto-assign', { method: 'POST' });
      setFlash(
        `${r.assigned} booking${r.assigned === 1 ? '' : 's'} assigned to free dentists.` +
          (r.left ? ` ${r.left} couldn’t be placed without a clash; assign those from Bookings → “No dentist yet”.` : ''),
      );
      dentists.reload();
      emitBookingsChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t assign them.');
    } finally {
      setBusy(null);
    }
  }

  // Accounts that can still be linked (not linked to another dentist).
  const linkable = (forDentist: number | null) =>
    accounts.filter((a) => a.active && !dentists.all.some((d) => d.userId === a.id && d.id !== forDentist));

  return (
    <>
      <Flash message={flash} />
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {!canEdit && <div className="alert alert-info">Only an admin can change dentists.</div>}

      {canEdit && dentists.unassignedUpcoming > 0 && dentists.active.length > 0 && (
        <div className="alert alert-warn assign-banner">
          <span>
            <strong>
              {dentists.unassignedUpcoming} upcoming booking{dentists.unassignedUpcoming === 1 ? ' has' : 's have'} no dentist yet.
            </strong>{' '}
            Each one goes to a dentist who is free at that time (returning patients stay with their usual dentist).
          </span>
          <div className="action-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'assign'} onClick={autoAssign}>
              {busy === 'assign' && <span className="spinner" aria-hidden="true" />}
              Assign automatically
            </button>
            <Link to="/admin?view=all&dentist=unassigned" className="btn btn-ghost btn-sm">
              Review them first
            </Link>
          </div>
        </div>
      )}

      <div className="detail-card">
        <div className="card-head">
          <div>
            <h3 className="detail-card-title">Dentists</h3>
            <p className="field-hint">
              Each dentist sees one patient at a time on the days they work. Patients can choose a dentist online, or “Any dentist”. Changes save straight away.
            </p>
          </div>
        </div>
        {!dentists.loaded ? (
          <p className="muted">Loading…</p>
        ) : dentists.all.length === 0 ? (
          <p className="muted detail-empty">No dentists yet. Add the first one below; until then, bookings work without a dentist.</p>
        ) : (
          <ul className="dentist-list">
            {dentists.all.map((d) => (
              <li key={d.id} className={d.active ? '' : 'is-inactive'}>
                <div className="dentist-row-main">
                  <span className="dentist-swatch" style={{ background: d.color }} aria-hidden="true" />
                  {canEdit ? (
                    <input
                      className="input dentist-name-input"
                      aria-label="Dentist name"
                      value={nameDrafts[d.id] ?? d.name}
                      onChange={(e) => setNameDrafts((n) => ({ ...n, [d.id]: e.target.value }))}
                      onBlur={() => {
                        const v = (nameDrafts[d.id] ?? d.name).trim();
                        if (v && v !== d.name) patch(d, { name: v }, `Renamed to ${v}.`);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <strong>{d.name}</strong>
                  )}
                  {!d.active && <span className="tag tag-warn">Inactive</span>}
                </div>
                <DayToggles
                  label={`Working days for ${d.name}`}
                  days={d.workingDays}
                  disabled={!canEdit || busy === d.id}
                  onToggle={(day) => {
                    const next = toggleDay(d.workingDays, day);
                    if (next.length === 0) {
                      setError('A dentist needs at least one working day. Deactivate them instead.');
                      return;
                    }
                    patch(d, { workingDays: next }, `${d.name} now works ${describeWorkingDays(next)}.`);
                  }}
                />
                <div className="dentist-row-side">
                  {canEdit ? (
                    <>
                      <label className="visually-hidden" htmlFor={`${uid}-login-${d.id}`}>
                        Login for {d.name}
                      </label>
                      <select
                        id={`${uid}-login-${d.id}`}
                        className="select select-sm"
                        value={d.userId ?? ''}
                        onChange={(e) =>
                          patch(d, { userId: e.target.value ? Number(e.target.value) : null }, e.target.value ? 'Login linked: they’ll see their own patients first.' : 'Login unlinked.')
                        }
                        title="Linking a login shows this dentist their own patients by default"
                      >
                        <option value="">No login</option>
                        {linkable(d.id).map((a) => (
                          <option key={a.id} value={a.id} title={a.email}>
                            Login: {a.name}
                          </option>
                        ))}
                      </select>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={d.active}
                          disabled={busy === d.id}
                          onChange={(e) => patch(d, { active: e.target.checked }, e.target.checked ? `${d.name} is active again.` : `${d.name} won’t get new bookings.`)}
                        />
                        <span>Active</span>
                      </label>
                    </>
                  ) : (
                    <span className="muted">{describeWorkingDays(d.workingDays)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canEdit && (
        <form className="detail-card new-booking" onSubmit={add}>
          <h3 className="detail-card-title">Add a dentist</h3>
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-new-name`}>
                Name
              </label>
              <input
                id={`${uid}-new-name`}
                className="input"
                placeholder="e.g. Dr. Ana Reyes"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-new-login`}>
                Login <span className="field-optional">Optional</span>
              </label>
              <select id={`${uid}-new-login`} className="select" value={newUser ?? ''} onChange={(e) => setNewUser(e.target.value ? Number(e.target.value) : null)}>
                <option value="">No login</option>
                {linkable(null).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.email})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <span className="field-label">Working days</span>
            <DayToggles label="Working days" days={newDays} onToggle={(day) => setNewDays((d) => toggleDay(d, day))} />
          </div>
          <div className="action-row">
            <button type="submit" className="btn btn-primary" disabled={busy === 'new' || newName.trim().length < 2 || newDays.length === 0}>
              {busy === 'new' && <span className="spinner" aria-hidden="true" />}
              Add dentist
            </button>
          </div>
        </form>
      )}
    </>
  );
}

// ---------- Blocked times ----------

export function BlockedTimesSettings() {
  const adminApi = useAdminApi();
  const [closures, setClosures] = useState<Closure[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useFlash();

  const load = useCallback(() => {
    adminApi<{ closures: Closure[] }>('/api/admin/closures')
      .then((r) => setClosures(r.closures))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t load blocked times.'));
  }, [adminApi]);
  useEffect(() => {
    document.title = 'Blocked times · Beatifics Admin';
    load();
  }, [load]);
  useOnBookingsChanged(load);

  async function remove(c: Closure) {
    setRemoving(c.id);
    try {
      await adminApi(`/api/admin/closures/${c.id}`, { method: 'DELETE' });
      setFlash('Blocked time removed. Those times can be booked again.');
      emitBookingsChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t remove it.');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <>
      <Flash message={flash} />
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {adding ? (
        <BlockTimeForm
          onSaved={() => {
            setAdding(false);
            setFlash('Time blocked.');
          }}
        />
      ) : (
        <div className="detail-card">
          <div className="card-head">
            <div>
              <h3 className="detail-card-title">Upcoming and repeating</h3>
              <p className="field-hint">Holidays, days off and breaks. Patients can’t book these times online.</p>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + Block time
            </button>
          </div>
          {!closures ? (
            <p className="muted">Loading…</p>
          ) : closures.length === 0 ? (
            <p className="muted detail-empty">Nothing blocked. Tip: add a daily lunch break, or block holidays in advance.</p>
          ) : (
            <ul className="closure-list">
              {closures.map((c) => {
                const d = describeClosure(c);
                const ongoing = c.startDate <= manilaToday();
                return (
                  <li key={c.id}>
                    <div>
                      <strong>
                        {c.reason || 'Blocked time'}
                        {c.dentistId && <DentistBadge id={c.dentistId} />}
                      </strong>
                      <span>
                        {d.when} · {d.time}
                        {ongoing && c.repeat !== 'none' && <span className="tag tag-muted">Active</span>}
                      </span>
                    </div>
                    <button type="button" className="btn btn-danger btn-sm" disabled={removing === c.id} onClick={() => remove(c)}>
                      {removing === c.id && <span className="spinner" aria-hidden="true" />}
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

// ---------- Staff accounts ----------

function AddStaffForm({ onAdded, onCancel }: { onAdded: (u: StaffAccount) => void; onCancel: () => void }) {
  const adminApi = useAdminApi();
  const uid = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = newUserSchema.safeParse({ name, email, role, password });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const r = await adminApi<{ user: StaffAccount }>('/api/admin/users', { method: 'POST', body: parsed.data });
      onAdded(r.user);
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        setErrors(err.fields);
      } else setFormError('Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="detail-card new-booking" onSubmit={submit} noValidate>
      <h3 className="detail-card-title">Add a staff account</h3>
      {formError && <div className="alert alert-error">{formError}</div>}
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-name`}>Name</label>
          <input id={`${uid}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-email`}>Email (used to sign in)</label>
          <input id={`${uid}-email`} type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
          {errors.email && <span className="field-error">{errors.email}</span>}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Role</span>
        <div className="role-options">
          {ROLES.map((r) => (
            <label key={r} className={`role-option${role === r ? ' is-active' : ''}`}>
              <input type="radio" name={`${uid}-role`} checked={role === r} onChange={() => setRole(r)} />
              <strong>{ROLE_LABELS[r]}</strong>
              <span>{ROLE_HINTS[r]}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${uid}-pw`}>Temporary password</label>
        <input id={`${uid}-pw`} className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <span className="field-hint">At least {PASSWORD_MIN} characters. Share it privately; they can change it under My account.</span>
        {errors.password && <span className="field-error">{errors.password}</span>}
      </div>
      <div className="action-row">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving && <span className="spinner" aria-hidden="true" />}
          Add account
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function StaffSettings() {
  const adminApi = useAdminApi();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<StaffAccount[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useFlash();

  const load = useCallback(() => {
    adminApi<{ users: StaffAccount[] }>('/api/admin/users')
      .then((r) => setUsers(r.users))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t load accounts.'));
  }, [adminApi]);
  useEffect(() => {
    document.title = 'Staff · Beatifics Admin';
    load();
  }, [load]);

  async function patch(u: StaffAccount, body: Record<string, unknown>, msg: string) {
    setBusy(u.id);
    setError('');
    try {
      await adminApi(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
      setFlash(msg);
      setResetFor(null);
      setNewPassword('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t update that account.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Flash message={flash} />
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {adding && (
        <AddStaffForm
          onCancel={() => setAdding(false)}
          onAdded={(u) => {
            setAdding(false);
            setFlash(`Account added for ${u.name}.`);
            load();
          }}
        />
      )}
      <div className="detail-card">
        <div className="card-head">
          <div>
            <h3 className="detail-card-title">Who can sign in</h3>
            <p className="field-hint">Deactivated accounts are signed out straight away and can’t sign in.</p>
          </div>
          {!adding && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + Add staff
            </button>
          )}
        </div>
        {!users ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="staff-list">
            {users.map((u) => {
              const self = u.id === me?.id;
              return (
                <li key={u.id} className={u.active ? '' : 'is-inactive'}>
                  <div className="staff-who">
                    <span className="admin-avatar" aria-hidden="true">{u.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <strong>
                        {u.name} {self && <span className="tag tag-muted">You</span>}
                        {!u.active && <span className="tag tag-warn">Deactivated</span>}
                      </strong>
                      <span>{u.email}</span>
                      <small>{u.lastLoginAt ? `Last signed in ${timeAgo(u.lastLoginAt)}` : 'Never signed in'}</small>
                    </div>
                  </div>
                  <div className="staff-actions">
                    <label className="visually-hidden" htmlFor={`role-${u.id}`}>Role for {u.name}</label>
                    <select
                      id={`role-${u.id}`}
                      className="select select-sm"
                      value={u.role}
                      disabled={self || busy === u.id}
                      onChange={(e) => patch(u, { role: e.target.value }, `${u.name} is now ${ROLE_LABELS[e.target.value as Role].toLowerCase()}.`)}
                      title={self ? 'You can’t change your own role' : ROLE_HINTS[u.role]}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setNewPassword(''); }}>
                      Reset password
                    </button>
                    {!self && (
                      <button
                        type="button"
                        className={`btn btn-sm ${u.active ? 'btn-danger' : 'btn-secondary'}`}
                        disabled={busy === u.id}
                        onClick={() => patch(u, { active: !u.active }, u.active ? `${u.name} was deactivated and signed out.` : `${u.name} can sign in again.`)}
                      >
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </div>
                  {resetFor === u.id && (
                    <form
                      className="staff-reset"
                      onSubmit={(e) => {
                        e.preventDefault();
                        patch(u, { password: newPassword }, `Password reset for ${u.name}. They’ve been signed out.`);
                      }}
                    >
                      <label className="field-label" htmlFor={`pw-${u.id}`}>New temporary password for {u.name}</label>
                      <div className="action-row">
                        <input id={`pw-${u.id}`} className="input" value={newPassword} minLength={PASSWORD_MIN} onChange={(e) => setNewPassword(e.target.value)} autoFocus autoComplete="new-password" />
                        <button type="submit" className="btn btn-primary btn-sm" disabled={newPassword.length < PASSWORD_MIN || busy === u.id}>
                          Set password
                        </button>
                      </div>
                      <span className="field-hint">At least {PASSWORD_MIN} characters.</span>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

// ---------- Activity ----------

export function ActivitySettings() {
  const adminApi = useAdminApi();
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Activity · Beatifics Admin';
    adminApi<{ activity: AuditEntry[] }>('/api/admin/activity?limit=200')
      .then((r) => setActivity(r.activity))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t load activity.'));
  }, [adminApi]);

  return (
    <div className="detail-card">
      <h3 className="detail-card-title">Recent activity</h3>
      <p className="field-hint">Every change to bookings, settings, blocked times and accounts, newest first.</p>
      {error && <div className="alert alert-error">{error}</div>}
      {!activity ? (
        <p className="muted">Loading…</p>
      ) : activity.length === 0 ? (
        <p className="muted detail-empty">Nothing yet.</p>
      ) : (
        <ol className="activity-list activity-feed">
          {activity.map((a) => (
            <li key={a.id} className={`activity-${a.actorType}`}>
              <span className="activity-summary">
                {a.bookingId ? <Link to={`/admin/bookings/${a.bookingId}`}>{a.summary}</Link> : a.summary}
              </span>
              <span className="activity-meta">
                {a.actor} · <time title={formatDateTime(a.at)}>{timeAgo(a.at)}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------- My account ----------

export function AccountSettings() {
  const adminApi = useAdminApi();
  const { user } = useAuth();
  const uid = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [flash, setFlash] = useFlash();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'My account · Beatifics Admin';
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError('');
    if (next.length < PASSWORD_MIN) {
      setErrors({ newPassword: `Use at least ${PASSWORD_MIN} characters.` });
      return;
    }
    setSaving(true);
    try {
      await adminApi('/api/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      setFlash('Password changed. Other devices were signed out.');
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        setErrors(err.fields);
      } else setFormError('Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Flash message={flash} />
      <div className="detail-card">
        <h3 className="detail-card-title">Signed in as</h3>
        <p className="account-who">
          <strong>{user?.name}</strong> · {user?.email} · <span className="tag tag-muted">{user ? ROLE_LABELS[user.role] : ''}</span>
        </p>
      </div>
      <form className="detail-card new-booking" onSubmit={submit} noValidate>
        <h3 className="detail-card-title">Change password</h3>
        {formError && <div className="alert alert-error">{formError}</div>}
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-cur`}>Current password</label>
            <input id={`${uid}-cur`} type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            {errors.currentPassword && <span className="field-error">{errors.currentPassword}</span>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-new`}>New password</label>
            <input id={`${uid}-new`} type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            <span className="field-hint">At least {PASSWORD_MIN} characters.</span>
            {errors.newPassword && <span className="field-error">{errors.newPassword}</span>}
          </div>
        </div>
        <div className="action-row">
          <button type="submit" className="btn btn-primary" disabled={saving || !current || !next}>
            {saving && <span className="spinner" aria-hidden="true" />}
            Change password
          </button>
        </div>
      </form>
    </>
  );
}
