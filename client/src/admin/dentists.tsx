import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Dentist } from '../../../shared/dentists.ts';
import { useAdminApi } from './auth.tsx';
import { useOnBookingsChanged } from './events.ts';

interface DentistsState {
  /** All dentists, active first. */
  all: Dentist[];
  active: Dentist[];
  byId: (id: number | null | undefined) => Dentist | undefined;
  unassignedUpcoming: number;
  loaded: boolean;
  reload: () => void;
}

const DentistsContext = createContext<DentistsState | null>(null);

/** Loads the dentist list once for the whole admin portal. */
export function DentistsProvider({ children }: { children: ReactNode }) {
  const adminApi = useAdminApi();
  const [all, setAll] = useState<Dentist[]>([]);
  const [unassignedUpcoming, setUnassigned] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    adminApi<{ dentists: Dentist[]; unassignedUpcoming: number }>('/api/admin/dentists')
      .then((r) => {
        setAll(r.dentists);
        setUnassigned(r.unassignedUpcoming);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [adminApi]);

  useEffect(reload, [reload]);
  useOnBookingsChanged(reload);

  const value = useMemo<DentistsState>(() => {
    const map = new Map(all.map((d) => [d.id, d]));
    return {
      all,
      active: all.filter((d) => d.active),
      byId: (id) => (id == null ? undefined : map.get(id)),
      unassignedUpcoming,
      loaded,
      reload,
    };
  }, [all, unassignedUpcoming, loaded, reload]);

  return <DentistsContext.Provider value={value}>{children}</DentistsContext.Provider>;
}

export function useDentists(): DentistsState {
  const ctx = useContext(DentistsContext);
  if (!ctx) throw new Error('useDentists must be used inside DentistsProvider');
  return ctx;
}

/** Colour dot + name. The name is always shown, so colour is never the only cue. */
export function DentistBadge({ id, compact }: { id: number | null; compact?: boolean }) {
  const { byId, active } = useDentists();
  if (active.length === 0 && id === null) return null;
  const d = byId(id);
  if (!d) return <span className="dentist-badge is-none">{compact ? 'No dentist' : 'No dentist yet'}</span>;
  return (
    <span className="dentist-badge">
      <span className="dentist-dot" style={{ background: d.color }} aria-hidden="true" />
      {d.name}
    </span>
  );
}

/** Dentist picker used in forms. `allowNone` adds an "Unassigned" option. */
export function DentistSelect({
  id,
  value,
  onChange,
  allowNone = true,
  className = 'select',
}: {
  id?: string;
  value: number | null;
  onChange: (id: number | null) => void;
  allowNone?: boolean;
  className?: string;
}) {
  const { active, byId } = useDentists();
  const current = byId(value);
  return (
    <select
      id={id}
      className={className}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      style={current ? { boxShadow: `inset 4px 0 0 ${current.color}` } : undefined}
    >
      {allowNone && <option value="">Unassigned</option>}
      {active.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
      {current && !current.active && <option value={current.id}>{current.name} (inactive)</option>}
    </select>
  );
}
