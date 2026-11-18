import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AlertsMenu, Toasts, useAlerts } from './alerts.tsx';
import { useAuth } from './auth.tsx';
import { DentistsProvider } from './dentists.tsx';
import { isTyping } from './events.ts';
import '../styles/admin.css';

const NAV = [
  { to: '/admin', label: 'Bookings', match: (p: string) => p === '/admin' || p.startsWith('/admin/bookings') },
  { to: '/admin/calendar', label: 'Calendar', match: (p: string) => p.startsWith('/admin/calendar') },
  { to: '/admin/reports', label: 'Reports', match: (p: string) => p.startsWith('/admin/reports') },
  { to: '/admin/settings', label: 'Settings', match: (p: string) => p.startsWith('/admin/settings') },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const alerts = useAlerts();

  // Single-key shortcuts for the reception desk: N = new appointment, C = calendar, B = bookings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        navigate(pathname.startsWith('/admin/calendar') ? `/admin/calendar/new${search}` : '/admin/bookings/new');
      } else if (k === 'c') navigate('/admin/calendar');
      else if (k === 'b') navigate('/admin');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, pathname, search]);

  return (
    <div className="admin">
      <a href="#admin-main" className="skip-link">
        Skip to content
      </a>
      <header className="admin-bar">
        <Link to="/admin" className="admin-brand" aria-label="Beatifics Admin – bookings">
          <img src="/images/wordmark-smooth-teal.png" alt="Beatifics" width={94} height={28} />
          <span className="admin-brand-tag">Admin</span>
        </Link>
        <nav className="admin-nav" aria-label="Admin">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={`admin-nav-link${n.match(pathname) ? ' is-active' : ''}`} end>
              {n.label}
              {n.to === '/admin' && !!alerts.pending && <span className="nav-count">{alerts.pending}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="admin-bar-right">
          <AlertsMenu alerts={alerts} />
          <a href="/" target="_blank" rel="noopener noreferrer" className="admin-bar-link">
            View site ↗
          </a>
          <Link to="/admin/settings/account" className="admin-user" title={`${user?.email} · My account`}>
            <span className="admin-avatar" aria-hidden="true">
              {user?.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="admin-user-name">{user?.name}</span>
          </Link>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await logout().catch(() => setSigningOut(false));
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main id="admin-main" className="admin-main">
        <DentistsProvider>
          <Outlet />
        </DentistsProvider>
      </main>
      <Toasts toasts={alerts.toasts} dismiss={alerts.dismiss} />
    </div>
  );
}
