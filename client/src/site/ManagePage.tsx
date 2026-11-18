import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CLINIC, manageLookupSchema, zodFieldErrors, type BookingStatus, type PublicBooking } from '../../../shared/booking.ts';
import { formatDateLong, relativeDay, utcIsoToManilaLocal } from '../../../shared/dates.ts';
import { formatDuration, formatTime, fromMinutes, toMinutes, type AvailabilityResponse } from '../../../shared/schedule.ts';
import { api, ApiError } from '../lib/api.ts';
import { focusField, SlotPicker, useAvailability } from './SlotPicker.tsx';
import '../styles/site.css';

/** Patient-friendly status wording. */
const PATIENT_STATUS: Record<BookingStatus, { label: string; note: string }> = {
  pending: { label: 'Waiting for confirmation', note: 'We’ll call or text you to confirm this time.' },
  confirmed: { label: 'Confirmed', note: 'See you then! Please arrive 10 minutes early.' },
  completed: { label: 'Completed', note: 'Thank you for visiting us.' },
  no_show: { label: 'Missed', note: 'We missed you at this appointment. Book again any time.' },
  cancelled: { label: 'Cancelled', note: 'This booking is cancelled.' },
};

function slotText(b: PublicBooking) {
  const local = utcIsoToManilaLocal(b.startAt);
  const start = local.slice(11, 16);
  return {
    date: local.slice(0, 10),
    time: `${formatTime(start)} – ${formatTime(fromMinutes(toMinutes(start) + b.durationMinutes))}`,
  };
}

function RescheduleForm({
  credentials,
  booking,
  onDone,
  onCancel,
}: {
  credentials: { reference: string; mobile: string };
  booking: PublicBooking;
  onDone: (b: PublicBooking) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [errors, setErrors] = useState<{ preferredDate?: string; preferredTime?: string }>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const availability = useAvailability(
    () => api<AvailabilityResponse>('/api/manage/availability', { method: 'POST', body: credentials }),
    booking.reference,
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const missing = !date ? { preferredDate: 'Please choose a day.' } : !time ? { preferredTime: 'Please choose a time.' } : null;
    if (missing) {
      setErrors(missing);
      focusField(formRef.current, Object.keys(missing)[0]);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const r = await api<{ booking: PublicBooking }>('/api/manage/reschedule', {
        method: 'POST',
        body: { ...credentials, preferredDate: date, preferredTime: time },
      });
      onDone(r.booking);
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        setErrors(err.fields);
        if (err.status === 409) {
          setTime('');
          availability.reload();
        }
      } else setFormError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form ref={formRef} className="booking-form" onSubmit={submit} noValidate>
      <h3 className="manage-subtitle">Choose a new time</h3>
      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}
      <SlotPicker
        idPrefix={uid}
        availability={availability}
        date={date}
        time={time}
        onDate={(d, closedError) => {
          setDate(d);
          setTime('');
          setErrors(closedError ? { preferredDate: closedError } : {});
        }}
        onTime={(t) => {
          setTime(t);
          setErrors({});
        }}
        errors={errors}
      />
      <div className="action-row">
        <button type="submit" className="btn btn-primary btn-lg" disabled={saving}>
          {saving && <span className="spinner" aria-hidden="true" />}
          Move my appointment
        </button>
        <button type="button" className="btn btn-ghost btn-lg" onClick={onCancel}>
          Keep current time
        </button>
      </div>
      <p className="form-footnote">We’ll confirm your new time by call or text.</p>
    </form>
  );
}

export function ManagePage() {
  const uid = useId();
  const [params] = useSearchParams();
  const [reference, setReference] = useState(params.get('ref') ?? '');
  const [mobile, setMobile] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState<PublicBooking | null>(null);
  const [credentials, setCredentials] = useState<{ reference: string; mobile: string } | null>(null);
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const mobileRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Manage your booking · Beatifics Dental Clinic';
    // Coming from the confirmation screen the reference is already filled in, so start at the mobile number.
    (params.get('ref') ? mobileRef : refRef).current?.focus();
  }, [params]);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    const parsed = manageLookupSchema.safeParse({ reference, mobile });
    if (!parsed.success) {
      const fields = zodFieldErrors(parsed.error);
      setErrors(fields);
      (fields.reference ? refRef : mobileRef).current?.focus();
      return;
    }
    setLoading(true);
    try {
      const creds = { reference: parsed.data.reference, mobile };
      const r = await api<{ booking: PublicBooking }>('/api/manage/lookup', { method: 'POST', body: creds });
      setCredentials(creds);
      setBooking(r.booking);
      setMode('view');
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function cancelBooking() {
    if (!credentials) return;
    setBusy(true);
    setFormError('');
    try {
      const r = await api<{ booking: PublicBooking }>('/api/manage/cancel', { method: 'POST', body: credentials });
      setBooking(r.booking);
      setMode('view');
      setFlash('Your appointment has been cancelled. We hope to see you another time.');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const s = booking ? slotText(booking) : null;

  return (
    <div className="manage-page">
      <header className="manage-header">
        <Link to="/" aria-label="Beatifics Dental Clinic home">
          <img src="/images/wordmark-smooth-teal.png" alt="Beatifics" width={121} height={36} />
        </Link>
        <a href={CLINIC.phoneHref} className="btn btn-secondary btn-sm">
          Call {CLINIC.phoneDisplay}
        </a>
      </header>

      <main className="manage-main">
        <div className="manage-intro">
          <span className="eyebrow">Your booking</span>
          <h1 className="section-title">Change or cancel your appointment</h1>
          <p>Use the reference from your confirmation and the mobile number you booked with.</p>
        </div>

        {!booking ? (
          <form className="book-card manage-card booking-form" onSubmit={lookup} noValidate>
            {formError && (
              <div className="alert alert-error" role="alert">
                {formError}
              </div>
            )}
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-ref`}>
                Booking reference
              </label>
              <input
                ref={refRef}
                id={`${uid}-ref`}
                className="input manage-ref-input"
                placeholder="BD-7K3Q9"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={reference}
                onChange={(e) => {
                  setReference(e.target.value.toUpperCase());
                  setErrors(({ reference: _, ...rest }) => rest);
                }}
                aria-invalid={errors.reference ? true : undefined}
                aria-describedby={errors.reference ? `${uid}-ref-err` : undefined}
              />
              {errors.reference && (
                <span className="field-error" id={`${uid}-ref-err`}>
                  {errors.reference}
                </span>
              )}
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${uid}-mobile`}>
                Mobile number
              </label>
              <input
                ref={mobileRef}
                id={`${uid}-mobile`}
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0917 123 4567"
                value={mobile}
                onChange={(e) => {
                  setMobile(e.target.value);
                  setErrors(({ mobile: _, ...rest }) => rest);
                }}
                aria-invalid={errors.mobile ? true : undefined}
                aria-describedby={errors.mobile ? `${uid}-mobile-err` : undefined}
              />
              {errors.mobile && (
                <span className="field-error" id={`${uid}-mobile-err`}>
                  {errors.mobile}
                </span>
              )}
            </div>
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={loading}>
              {loading && <span className="spinner" aria-hidden="true" />}
              Find my booking
            </button>
            <p className="form-footnote">
              Lost your reference? Call <a href={CLINIC.phoneHref}>{CLINIC.phoneDisplay}</a> and we’ll help. ·{' '}
              <Link to="/privacy">Privacy policy</Link>
            </p>
          </form>
        ) : (
          <div className="book-card manage-card">
            <div className="flash" role="status" aria-live="polite">
              {flash && <div className="alert alert-success">✓ {flash}</div>}
            </div>
            {formError && (
              <div className="alert alert-error" role="alert">
                {formError}
              </div>
            )}

            <div className="manage-booking">
              <span className={`manage-status manage-status-${booking.status}`}>{PATIENT_STATUS[booking.status].label}</span>
              <h2 ref={resultRef} tabIndex={-1}>
                {formatDateLong(s!.date)}
              </h2>
              <p className="manage-time">
                {s!.time} <span>· about {formatDuration(booking.durationMinutes)}</span>
                {(booking.status === 'pending' || booking.status === 'confirmed') && (
                  <span className="manage-rel">{relativeDay(s!.date)}</span>
                )}
              </p>
              <p className="manage-meta">
                {booking.service}
                {booking.dentistName && <> · with {booking.dentistName}</>} · Ref {booking.reference}
              </p>
              <p className="manage-note">{PATIENT_STATUS[booking.status].note}</p>
            </div>

            {mode === 'reschedule' && credentials ? (
              <RescheduleForm
                credentials={credentials}
                booking={booking}
                onCancel={() => setMode('view')}
                onDone={(b) => {
                  setBooking(b);
                  setMode('view');
                  setFlash('Your appointment has been moved. We’ll call or text you to confirm the new time.');
                  requestAnimationFrame(() => resultRef.current?.focus());
                }}
              />
            ) : mode === 'cancel' ? (
              <div className="confirm-prompt" role="alertdialog" aria-labelledby={`${uid}-ask`}>
                <p id={`${uid}-ask`}>Cancel your appointment on {formatDateLong(s!.date)}?</p>
                <div className="action-row">
                  <button type="button" className="btn btn-danger-solid" onClick={cancelBooking} disabled={busy}>
                    {busy && <span className="spinner" aria-hidden="true" />}
                    Yes, cancel it
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setMode('view')} autoFocus>
                    Keep my appointment
                  </button>
                </div>
              </div>
            ) : booking.canChange ? (
              <div className="action-row">
                <button type="button" className="btn btn-primary btn-lg" onClick={() => { setFlash(''); setMode('reschedule'); }}>
                  Change time
                </button>
                <button type="button" className="btn btn-danger btn-lg" onClick={() => { setFlash(''); setMode('cancel'); }}>
                  Cancel booking
                </button>
              </div>
            ) : booking.status === 'pending' || booking.status === 'confirmed' ? (
              <div className="alert alert-info">
                <span>
                  Your appointment is today, so changes need a quick call: <a href={CLINIC.phoneHref}>{CLINIC.phoneDisplay}</a>.
                </span>
              </div>
            ) : (
              <a href="/#book" className="btn btn-primary btn-lg">
                Book a new appointment
              </a>
            )}

            <button
              type="button"
              className="manage-other"
              onClick={() => {
                setBooking(null);
                setCredentials(null);
                setFlash('');
                setFormError('');
                setReference('');
              }}
            >
              Look up a different booking
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
