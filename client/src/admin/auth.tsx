import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { StaffUser } from '../../../shared/booking.ts';
import { api, ApiError } from '../lib/api.ts';

interface AuthState {
  /** undefined = still checking, null = signed out */
  user: StaffUser | null | undefined;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Call when an admin API returns 401, e.g. the session expired. */
  sessionExpired: () => void;
  expired: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StaffUser | null | undefined>(undefined);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (user !== undefined) return;
    let cancelled = false;
    api<{ user: StaffUser }>('/api/auth/me')
      .then((r) => !cancelled && setUser(r.user))
      .catch(() => !cancelled && setUser(null));
    return () => {
      cancelled = true;
    };
  }, [user]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ user: StaffUser }>('/api/auth/login', { method: 'POST', body: { email, password } });
    setExpired(false);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
    }
  }, []);

  const sessionExpired = useCallback(() => {
    setExpired(true);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, login, logout, sessionExpired, expired }), [user, login, logout, sessionExpired, expired]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Wrap admin API calls so an expired session sends staff back to the login screen. */
export function useAdminApi() {
  const { sessionExpired } = useAuth();
  return useCallback(
    async <T,>(path: string, options?: Parameters<typeof api>[1]): Promise<T> => {
      try {
        return await api<T>(path, options);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) sessionExpired();
        throw err;
      }
    },
    [sessionExpired],
  );
}

export function RequireStaff({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) {
    return (
      <div className="admin-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/admin/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}
