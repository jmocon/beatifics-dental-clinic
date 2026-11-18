import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEntry, UpdatesResponse } from '../../../shared/booking.ts';
import { timeAgo } from '../../../shared/dates.ts';
import { useAdminApi } from './auth.tsx';
import { emitBookingsChanged } from './events.ts';

const POLL_VISIBLE_MS = 20_000;
const POLL_HIDDEN_MS = 60_000;
const SOUND_KEY = 'bd-alert-sound';

function readSoundPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** A short, soft two-note chime, generated so there's no audio file to load. */
function playChime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // Audio not available (or blocked until the first click); the toast still shows.
  }
}

const EVENT_TITLE: Record<string, string> = {
  'booking.requested': 'New request',
  'booking.cancelled_by_patient': 'Cancelled by patient',
  'booking.rescheduled_by_patient': 'Moved by patient',
};

export interface Toast {
  key: number;
  entry: AuditEntry;
  name: string;
}

/**
 * Polls for patient actions (new requests, cancellations, reschedules) and surfaces them:
 * toast + optional chime + desktop notification when the tab is hidden + pending count in the tab title.
 */
export function useAlerts() {
  const adminApi = useAdminApi();
  const [pending, setPending] = useState<number | null>(null);
  const [recent, setRecent] = useState<AuditEntry[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sound, setSoundState] = useState(readSoundPref);
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const since = useRef<string | null>(null);
  const toastKey = useRef(0);
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const dismiss = useCallback((key: number) => setToasts((t) => t.filter((x) => x.key !== key)), []);

  const poll = useCallback(async () => {
    try {
      const qs = since.current ? `?since=${encodeURIComponent(since.current)}` : '';
      const r = await adminApi<UpdatesResponse>(`/api/admin/updates${qs}`);
      since.current = r.serverTime;
      setPending(r.pending);
      if (r.events.length === 0) return;

      setRecent((old) => [...r.events.slice().reverse(), ...old].slice(0, 15));
      setUnseen((n) => n + r.events.length);
      emitBookingsChanged();
      if (soundRef.current) playChime();

      const fresh = r.events.slice(-3).map((entry) => ({ key: ++toastKey.current, entry, name: nameFrom(entry) }));
      setToasts((t) => [...t, ...fresh].slice(-4));
      for (const f of fresh) setTimeout(() => dismiss(f.key), 12_000);

      if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const e = r.events[r.events.length - 1];
        const n = new Notification(`${EVENT_TITLE[e.action] ?? 'Update'} · Beatifics`, {
          body: r.events.length > 1 ? `${r.events.length} updates. ${e.summary}` : e.summary,
          tag: 'beatifics-updates',
        });
        n.onclick = () => {
          window.focus();
          if (e.bookingId) window.location.assign(`/admin/bookings/${e.bookingId}`);
        };
      }
    } catch {
      // Network blip or signed out; the next poll will try again (401s are handled by useAdminApi).
    }
  }, [adminApi, dismiss]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const loop = async () => {
      await poll();
      if (!stopped) timer = setTimeout(loop, document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
    };
    loop();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        loop();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  // Pending count in the tab title, visible even when staff are in another tab.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = pending ? `(${pending}) ${base}` : base;
  });

  const setSound = (on: boolean) => {
    setSoundState(on);
    try {
      localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      // Preference just won't persist.
    }
    if (on) playChime();
  };

  const enableDesktop = async () => {
    if (typeof Notification === 'undefined') return;
    setNotifyPermission(await Notification.requestPermission());
  };

  return {
    pending,
    recent,
    unseen,
    markSeen: () => setUnseen(0),
    toasts,
    dismiss,
    sound,
    setSound,
    notifyPermission,
    enableDesktop,
    refresh: poll,
  };
}

function nameFrom(entry: AuditEntry): string {
  return EVENT_TITLE[entry.action] ?? 'Update';
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (key: number) => void }) {
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.key} className={`toast toast-${t.entry.action.replace(/\./g, '-')}`}>
          <div className="toast-body">
            <strong>{t.name}</strong>
            <span>{t.entry.summary}</span>
          </div>
          <div className="toast-actions">
            {t.entry.bookingId && (
              <Link to={`/admin/bookings/${t.entry.bookingId}`} className="btn btn-primary btn-sm" onClick={() => dismiss(t.key)}>
                Open
              </Link>
            )}
            <button type="button" className="toast-close" onClick={() => dismiss(t.key)} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AlertsMenu({ alerts }: { alerts: ReturnType<typeof useAlerts> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="alerts-menu" ref={ref}>
      <button
        type="button"
        className="bell-btn"
        aria-expanded={open}
        aria-label={`Notifications${alerts.unseen ? `, ${alerts.unseen} new` : ''}`}
        onClick={() => {
          setOpen((o) => !o);
          alerts.markSeen();
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z M10 19a2 2 0 0 0 4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {alerts.unseen > 0 && <span className="bell-dot">{alerts.unseen > 9 ? '9+' : alerts.unseen}</span>}
      </button>
      {open && (
        <div className="alerts-panel" role="dialog" aria-label="Notifications">
          <div className="alerts-panel-head">
            <strong>Patient updates</strong>
            <span className="muted">{alerts.pending ?? 0} waiting</span>
          </div>
          {alerts.recent.length === 0 ? (
            <p className="alerts-empty">Nothing new since you opened the portal. New online requests will show here with a chime.</p>
          ) : (
            <ul className="alerts-list">
              {alerts.recent.map((e) => (
                <li key={e.id}>
                  <Link to={e.bookingId ? `/admin/bookings/${e.bookingId}` : '/admin'} onClick={() => setOpen(false)}>
                    <strong>{EVENT_TITLE[e.action] ?? 'Update'}</strong>
                    <span>{e.summary}</span>
                    <small>{timeAgo(e.at)}</small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="alerts-prefs">
            <label className="switch">
              <input type="checkbox" checked={alerts.sound} onChange={(e) => alerts.setSound(e.target.checked)} />
              <span>Play a sound</span>
            </label>
            {alerts.notifyPermission === 'default' && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={alerts.enableDesktop}>
                Show desktop alerts
              </button>
            )}
            {alerts.notifyPermission === 'granted' && <span className="muted">Desktop alerts on</span>}
            {alerts.notifyPermission === 'denied' && <span className="muted">Desktop alerts blocked in browser settings</span>}
          </div>
        </div>
      )}
    </div>
  );
}
