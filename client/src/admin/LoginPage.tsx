import { useEffect, useId, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api.ts';
import { useAuth } from './auth.tsx';
import '../styles/admin.css';

export function LoginPage() {
  const { user, login, expired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/admin';
  const uid = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = 'Staff sign in · Beatifics Admin';
  }, []);

  if (user) return <Navigate to={from} replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await login(email, password);
      navigate(from.startsWith('/admin') ? from : '/admin', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <main className="login-card">
        <img src="/images/wordmark-smooth-teal.png" alt="Beatifics" className="login-logo" width={135} height={40} />
        <div className="login-head">
          <h1>Staff sign in</h1>
          <p>Manage appointment requests for Beatifics Dental Clinic.</p>
        </div>

        {expired && !error && (
          <div className="alert alert-info" role="status">
            Your session ended. Please sign in again.
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert" id={`${uid}-error`}>
            {error}
          </div>
        )}

        <form className="login-form" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-email`}>
              Email
            </label>
            <input
              id={`${uid}-email`}
              className="input"
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? `${uid}-error` : undefined}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-password`}>
              Password
            </label>
            <div className="password-wrap">
              <input
                id={`${uid}-password`}
                className="input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={error ? `${uid}-error` : undefined}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((s) => !s)}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>
        <p className="login-foot">
          Forgot your password? Ask the clinic administrator to reset it.
          <br />
          <Link to="/">← Back to the clinic website</Link>
        </p>
      </main>
    </div>
  );
}
