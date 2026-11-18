import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  CLINIC,
  formatPhMobile,
  STAFF_NOTES_MAX,
  STATUS_LABELS,
  type Booking,
  type BookingDetailResponse,
  type BookingStatus,
  type BookingUpdate,
} from '../../../shared/booking.ts';
import { formatDateLong, formatDateShort, formatDateTime, relativeDay, timeAgo, utcIsoToManilaLocal } from '../../../shared/dates.ts';
import { formatDuration, formatTime, fromMinutes, toMinutes } from '../../../shared/schedule.ts';
import { ApiError } from '../lib/api.ts';
import { useAdminApi } from './auth.tsx';
import { PatientTags } from './BookingsPage.tsx';
import { DentistBadge, useDentists } from './dentists.tsx';
import { emitBookingsChanged, useOnBookingsChanged, type PanelContext } from './events.ts';
import { ScheduleEditor, type ScheduleValue } from './ScheduleEditor.tsx';
import { StatusBadge } from './StatusBadge.tsx';

export function NoBookingSelected() {
  return (
    <div className="detail-placeholder">
      <span className="empty-icon" aria-hidden="true">
        ☰
      </span>
      <h2>Select a booking</h2>
      <p>Choose a request from the list to see the patient’s details, confirm or adjust the time, or update its status.</p>
      <p className="muted shortcut-hint">
        Shortcuts: <kbd>N</kbd> new appointment · <kbd>/</kbd> search · <kbd>C</kbd> calendar
      </p>
    </div>
  );
}

/** 'Wednesday, October 7 · 9:00 – 10:00 AM' parts for a booking. */
function slotText(b: Pick<Booking, 'startAt' | 'durationMinutes'>) {
  const local = utcIsoToManilaLocal(b.startAt);
  const start = local.slice(11, 16);
  const end = fromMinutes(toMinutes(start) + b.durationMinutes);
  return { date: local.slice(0, 10), start, time: `${formatTime(start)} – ${formatTime(end)}` };
}

function confirmationMessage(b: Booking): string {
  const first = b.fullName.split(/\s+/)[0];
  return (
    `Hi ${first}, this is ${CLINIC.name}. Your appointment is confirmed for ${formatDateTime(b.startAt)} ` +
    `(about ${formatDuration(b.durationMinutes)}). ` +
    `We're at ${CLINIC.addressLine1}, ${CLINIC.addressLine2}. ` +
    `To change or cancel, visit our website with reference ${b.reference} or call ${CLINIC.phoneDisplay}. Thank you!`
  );
}

type Busy = 'confirm' | 'reschedule' | 'cancel' | 'no_show' | 'completed' | 'reopen' | 'notes' | null;

const SHOW_HISTORY = 4;
const SHOW_ACTIVITY = 4;

export function BookingDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh, backTo, detailHref, nextPendingId } = useOutletContext<PanelContext>();
  const adminApi = useAdminApi();
  const dentists = useDentists();
  const uid = useId();

  const [data, setData] = useState<BookingDetailResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [flash, setFlash] = useState('');
  const [nextId, setNextId] = useState<number | null>(null);
  const [askConfirm, setAskConfirm] = useState<'cancel' | 'no_show' | null>(null);
  const [editingTime, setEditingTime] = useState(false);
  const [notes, setNotes] = useState('');
  const [copied, setCopied] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const notesDirtyRef = useRef(false);

  const fetchDetail = useCallback(
    () => adminApi<BookingDetailResponse>(`/api/admin/bookings/${id}`),
    [adminApi, id],
  );

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError('');
    setActionError('');
    setFlash('');
    setNextId(null);
    setAskConfirm(null);
    setEditingTime(false);
    setShowAllHistory(false);
    setShowAllActivity(false);
    fetchDetail()
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setNotes(r.booking.staffNotes);
        const passedFlash = (location.state as { flash?: string } | null)?.flash;
        if (passedFlash) setFlash(passedFlash);
        // Move focus to the detail on small screens where it replaces the list.
        if (window.matchMedia('(max-width: 899px)').matches) headingRef.current?.focus();
      })
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err.message : 'Couldn’t load this booking.'));
    return () => {
      cancelled = true;
    };
    // location.state is only read on first load of this booking.
  }, [fetchDetail]);

  // Stay current when something changes elsewhere (quick confirm, a patient cancelling, the calendar).
  useOnBookingsChanged(() => {
    fetchDetail()
      .then((r) => {
        setData(r);
        if (!notesDirtyRef.current) setNotes(r.booking.staffNotes);
      })
      .catch(() => {});
  });

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => {
      setFlash('');
      setNextId(null);
    }, 8000);
    return () => clearTimeout(t);
  }, [flash]);

  if (loadError) {
    return (
      <div className="detail">
        <Link to={backTo} className="detail-back">
          ← Back
        </Link>
        <div className="alert alert-error" role="alert">
          {loadError}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="detail" aria-busy="true">
        <div className="detail-skeleton">
          <span className="sk sk-1" />
          <span className="sk sk-2" />
          <span className="sk sk-3" />
        </div>
      </div>
    );
  }

  const b = data.booking;
  const slot = slotText(b);
  const dentistsActive = dentists.active.length > 0;
  const notesDirty = notes !== b.staffNotes;
  notesDirtyRef.current = notesDirty;
  const previousVisits = data.history.filter((h) => h.status !== 'cancelled' && h.startAt < b.startAt).length;
  const noShows = data.history.filter((h) => h.status === 'no_show').length;

  async function update(kind: Exclude<Busy, null>, body: BookingUpdate, success: string, offerNext = false) {
    setBusy(kind);
    setActionError('');
    setScheduleError('');
    try {
      const r = await adminApi<{ booking: Booking }>(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body });
      setData((d) => (d ? { ...d, booking: r.booking } : d));
      setNotes(r.booking.staffNotes);
      setAskConfirm(null);
      setEditingTime(false);
      setFlash(success);
      setNextId(offerNext ? (nextPendingId?.(b.id) ?? null) : null);
      refresh();
      emitBookingsChanged();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
      if (kind === 'confirm' || kind === 'reschedule') setScheduleError(message);
      else setActionError(message);
    } finally {
      setBusy(null);
    }
  }

  const setStatus = (status: BookingStatus, kind: Exclude<Busy, null>, msg: string, offerNext = false) =>
    update(kind, { status }, msg, offerNext);
  const timeChanged = (v: ScheduleValue) =>
    v.startAt !== utcIsoToManilaLocal(b.startAt) || v.durationMinutes !== b.durationMinutes || v.dentistId !== b.dentistId;

  const confirmPrompt = (what: 'cancel' | 'no_show') => (
    <div className="confirm-prompt" role="alertdialog" aria-labelledby={`${uid}-ask`}>
      <p id={`${uid}-ask`}>
        {what === 'cancel'
          ? b.status === 'pending'
            ? 'Cancel this request? The time will be freed up. The patient won’t be notified automatically.'
            : 'Cancel this appointment? The time will be freed up. The patient won’t be notified automatically.'
          : 'Mark as no-show? This can’t be undone.'}
      </p>
      <div className="action-row">
        <button
          type="button"
          className="btn btn-danger-solid btn-sm"
          disabled={busy !== null}
          onClick={() =>
            what === 'cancel'
              ? setStatus('cancelled', 'cancel', b.status === 'pending' ? 'Request cancelled.' : 'Appointment cancelled.', true)
              : setStatus('no_show', 'no_show', 'Marked as no-show.')
          }
        >
          {busy === what && <span className="spinner" aria-hidden="true" />}
          {what === 'cancel' ? 'Yes, cancel' : 'Yes, mark no-show'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAskConfirm(null)} autoFocus>
          Go back
        </button>
      </div>
    </div>
  );

  const smsHref = (body?: string) => `sms:${b.mobile}${body ? `?body=${encodeURIComponent(body)}` : ''}`;

  const slotBlock = (label: string) => (
    <div className="detail-appt">
      <span className="detail-label">{label}</span>
      <span className="detail-appt-when">
        {formatDateLong(slot.date)}
        <span className="detail-appt-rel">{relativeDay(slot.date)}</span>
      </span>
      <span className="detail-appt-time">
        {slot.time} <span className="muted">· {formatDuration(b.durationMinutes)}</span>
        {dentistsActive && (
          <span className="muted"> · {dentists.byId(b.dentistId)?.name ?? 'no dentist yet'}</span>
        )}
      </span>
    </div>
  );

  const history = showAllHistory ? data.history : data.history.slice(0, SHOW_HISTORY);
  const activity = showAllActivity ? data.activity : data.activity.slice(0, SHOW_ACTIVITY);

  return (
    <article className="detail" aria-labelledby={`${uid}-title`}>
      <Link to={backTo} className="detail-back">
        ← Back
      </Link>

      <header className="detail-head">
        <div>
          <h2 id={`${uid}-title`} ref={headingRef} tabIndex={-1}>
            {b.fullName}
          </h2>
          <p className="detail-ref">
            Ref <strong>{b.reference}</strong> · {b.source === 'staff' ? 'Added by staff' : 'Requested online'}{' '}
            {timeAgo(b.createdAt)}
          </p>
          <p className="detail-tags">
            <DentistBadge id={b.dentistId} />
            {b.dentistRequested && <span className="tag tag-new">Patient asked for this dentist</span>}
            <PatientTags patient={{ previousVisits, noShows }} />
          </p>
        </div>
        <StatusBadge status={b.status} />
      </header>

      <div className="flash" role="status" aria-live="polite">
        {flash && (
          <div className="alert alert-success flash-row">
            <span>✓ {flash}</span>
            {nextId && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(detailHref(nextId))} autoFocus>
                Next request →
              </button>
            )}
          </div>
        )}
      </div>
      {actionError && (
        <div className="alert alert-error" role="alert">
          {actionError}
        </div>
      )}

      {/* Contact */}
      <div className="detail-card contact-strip">
        <div>
          <span className="detail-label">Mobile</span>
          <a href={`tel:${b.mobile}`} className="detail-phone">
            {formatPhMobile(b.mobile)}
          </a>
        </div>
        <div className="action-row">
          <a href={`tel:${b.mobile}`} className="btn btn-tint btn-sm">
            Call
          </a>
          <a href={smsHref()} className="btn btn-secondary btn-sm">
            Text
          </a>
        </div>
      </div>

      {/* Appointment / actions */}
      <section className="detail-card" aria-labelledby={`${uid}-appt`}>
        <h3 id={`${uid}-appt`} className="detail-card-title">
          Appointment
        </h3>

        {b.status === 'pending' && (
          <>
            {slotBlock('Requested time')}
            <p className="field-hint">Adjust the time or length if needed, then confirm.</p>
            <ScheduleEditor
              key={`${b.id}-${b.updatedAt}`}
              booking={b}
              submitLabel="Confirm appointment"
              busy={busy === 'confirm'}
              error={scheduleError}
              onSubmit={(v) =>
                update(
                  'confirm',
                  { status: 'confirmed', ...(timeChanged(v) ? v : {}) },
                  timeChanged(v) ? 'Confirmed with the new time. Remember to tell the patient.' : 'Appointment confirmed.',
                  true,
                )
              }
            />
            <div className="detail-divider" />
            {askConfirm === 'cancel' ? (
              confirmPrompt('cancel')
            ) : (
              <button type="button" className="btn btn-danger btn-sm" onClick={() => setAskConfirm('cancel')}>
                Cancel request
              </button>
            )}
          </>
        )}

        {b.status === 'confirmed' && (
          <>
            {slotBlock('Confirmed for')}
            {editingTime ? (
              <ScheduleEditor
                booking={b}
                submitLabel="Save new time"
                busy={busy === 'reschedule'}
                error={scheduleError}
                onCancel={() => setEditingTime(false)}
                onSubmit={(v) => update('reschedule', v, 'Time updated. Remember to tell the patient.')}
              />
            ) : askConfirm ? (
              confirmPrompt(askConfirm)
            ) : (
              <>
                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy !== null}
                    onClick={() => setStatus('completed', 'completed', 'Marked as completed.')}
                  >
                    {busy === 'completed' && <span className="spinner" aria-hidden="true" />}
                    Mark completed
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingTime(true)}>
                    {dentistsActive ? 'Change time or dentist' : 'Change time or length'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAskConfirm('no_show')}>
                    No-show
                  </button>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => setAskConfirm('cancel')}>
                    Cancel
                  </button>
                </div>
                <div className="message-box">
                  <span className="detail-label">Confirmation message</span>
                  <p>{confirmationMessage(b)}</p>
                  <div className="action-row">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(confirmationMessage(b));
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        } catch {
                          setActionError('Couldn’t copy. Select the text and copy it manually.');
                        }
                      }}
                    >
                      {copied ? '✓ Copied' : 'Copy text'}
                    </button>
                    <a href={smsHref(confirmationMessage(b))} className="btn btn-ghost btn-sm">
                      Open in Messages
                    </a>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {(b.status === 'completed' || b.status === 'no_show') && (
          <>
            {slotBlock('Appointment')}
            <p className="detail-lead">
              This booking is {STATUS_LABELS[b.status].toLowerCase()} and can no longer be changed.
            </p>
          </>
        )}

        {b.status === 'cancelled' && (
          <>
            {slotBlock('Was booked for')}
            <p className="detail-lead">
              This booking was cancelled{b.updatedBy ? ` by ${b.updatedBy === 'Patient' ? 'the patient' : b.updatedBy}` : ''}.
              Reopen it if the patient still wants to come in. You can adjust the time after reopening.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={() => setStatus('pending', 'reopen', 'Request reopened. It’s back in “Needs action”.')}
            >
              {busy === 'reopen' && <span className="spinner" aria-hidden="true" />}
              Reopen request
            </button>
          </>
        )}
      </section>

      {/* Request details */}
      <section className="detail-card" aria-labelledby={`${uid}-req`}>
        <h3 id={`${uid}-req`} className="detail-card-title">
          Request
        </h3>
        <dl className="detail-grid">
          <div>
            <dt>Reason for visit</dt>
            <dd>
              {b.service}
              {b.service === 'Dental pain / urgent concern' && <span className="tag tag-warn">Urgent</span>}
            </dd>
          </div>
          <div>
            <dt>{b.source === 'staff' ? 'Added' : 'Requested'}</dt>
            <dd>{formatDateTime(b.createdAt)}</dd>
          </div>
        </dl>
        {b.source === 'online' && (
          <div className="patient-notes">
            <span className="detail-label">Patient’s note</span>
            {b.notes ? <blockquote>{b.notes}</blockquote> : <p className="muted">No note added.</p>}
          </div>
        )}
      </section>

      {/* Staff notes */}
      <section className="detail-card" aria-labelledby={`${uid}-notes`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (notesDirty) update('notes', { staffNotes: notes }, 'Notes saved.');
          }}
        >
          <h3 id={`${uid}-notes`} className="detail-card-title">
            <label htmlFor={`${uid}-staff-notes`}>Staff notes</label>
          </h3>
          <p className="field-hint">Only visible to clinic staff. Ctrl+Enter to save.</p>
          <textarea
            id={`${uid}-staff-notes`}
            className="textarea"
            rows={3}
            maxLength={STAFF_NOTES_MAX}
            value={notes}
            placeholder="e.g. Called 10:15 AM, no answer. Will try again after lunch."
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && notesDirty) {
                e.preventDefault();
                update('notes', { staffNotes: notes }, 'Notes saved.');
              }
            }}
          />
          <div className="action-row">
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!notesDirty || busy !== null}>
              {busy === 'notes' && <span className="spinner" aria-hidden="true" />}
              Save notes
            </button>
            {notesDirty && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotes(b.staffNotes)}>
                Discard changes
              </button>
            )}
          </div>
        </form>
      </section>

      {/* Patient history */}
      <section className="detail-card" aria-labelledby={`${uid}-hist`}>
        <h3 id={`${uid}-hist`} className="detail-card-title">
          Patient history
        </h3>
        {data.history.length === 0 ? (
          <p className="muted detail-empty">First booking with this mobile number.</p>
        ) : (
          <>
            <ul className="history-list">
              {history.map((h) => {
                const hs = slotText(h);
                return (
                  <li key={h.id}>
                    <Link to={detailHref(h.id)}>
                      <span className="history-date">
                        {formatDateShort(hs.date)}, {formatTime(hs.start)}
                      </span>
                      <span className="history-service">
                        {h.service}
                        {dentists.byId(h.dentistId) && ` · ${dentists.byId(h.dentistId)!.name}`}
                      </span>
                      <StatusBadge status={h.status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
            {data.history.length > SHOW_HISTORY && (
              <button type="button" className="link-btn" onClick={() => setShowAllHistory((s) => !s)}>
                {showAllHistory ? 'Show less' : `Show all ${data.history.length}`}
              </button>
            )}
          </>
        )}
      </section>

      {/* Activity */}
      <section className="detail-card" aria-labelledby={`${uid}-act`}>
        <h3 id={`${uid}-act`} className="detail-card-title">
          Activity
        </h3>
        {data.activity.length === 0 ? (
          <p className="muted detail-empty">No changes recorded yet.</p>
        ) : (
          <>
            <ol className="activity-list">
              {activity.map((a) => (
                <li key={a.id} className={`activity-${a.actorType}`}>
                  <span className="activity-summary">{a.summary}</span>
                  <span className="activity-meta">
                    {a.actor} · <time title={formatDateTime(a.at)}>{timeAgo(a.at)}</time>
                  </span>
                </li>
              ))}
            </ol>
            {data.activity.length > SHOW_ACTIVITY && (
              <button type="button" className="link-btn" onClick={() => setShowAllActivity((s) => !s)}>
                {showAllActivity ? 'Show less' : `Show all ${data.activity.length}`}
              </button>
            )}
          </>
        )}
      </section>
    </article>
  );
}
