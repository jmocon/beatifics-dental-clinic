import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  bookingRequestSchema,
  CLINIC,
  formatPhMobile,
  normalizePhMobile,
  NOTES_MAX,
  SERVICES,
  zodFieldErrors,
} from '../../../shared/booking.ts';
import { formatDateLong, utcIsoToManilaLocal, weekdayOf } from '../../../shared/dates.ts';
import type { PublicDentist } from '../../../shared/dentists.ts';
import { formatDuration, formatTime, type AvailabilityResponse } from '../../../shared/schedule.ts';
import { api, ApiError } from '../lib/api.ts';
import { focusField, SlotPicker, useAvailability } from './SlotPicker.tsx';

interface FormValues {
  fullName: string;
  mobile: string;
  service: string;
  /** null = any dentist */
  dentistId: number | null;
  preferredDate: string;
  preferredTime: string;
  notes: string;
  consent: boolean;
  website: string; // honeypot
}

const EMPTY: FormValues = {
  fullName: '',
  mobile: '',
  service: SERVICES[0],
  dentistId: null,
  preferredDate: '',
  preferredTime: '',
  notes: '',
  consent: false,
  website: '',
};

// Order used to move focus to the first problem after a failed submit.
const FIELD_ORDER = ['fullName', 'mobile', 'service', 'preferredDate', 'preferredTime', 'notes', 'consent'] as const;

interface Confirmation {
  firstName: string;
  reference: string;
  /** Manila 'YYYY-MM-DDTHH:mm' */
  start: string;
  durationMinutes: number;
  dentistName: string | null;
  mobile: string;
  duplicate: boolean;
}

export function BookingForm() {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<Confirmation | null>(null);
  const thanksRef = useRef<HTMLHeadingElement>(null);
  const [dentists, setDentists] = useState<PublicDentist[]>([]);
  useEffect(() => {
    api<{ dentists: PublicDentist[] }>('/api/dentists')
      .then((r) => setDentists(r.dentists))
      .catch(() => setDentists([]));
  }, []);
  const chosenDentist = dentists.find((d) => d.id === values.dentistId);

  // Free times depend on the service (some treatments take longer) and on the chosen dentist.
  const availability = useAvailability(
    () =>
      api<AvailabilityResponse>(
        `/api/availability?service=${encodeURIComponent(values.service)}&dentist=${values.dentistId ?? 'any'}`,
      ),
    `${values.service}|${values.dentistId}`,
  );

  function chooseDentist(id: number | null) {
    const d = dentists.find((x) => x.id === id);
    setValues((v) => {
      // Keep the chosen day unless the new dentist doesn't work then.
      const dayOff = d && v.preferredDate && !d.workingDays.includes(weekdayOf(v.preferredDate));
      return { ...v, dentistId: id, ...(dayOff ? { preferredDate: '', preferredTime: '' } : {}) };
    });
  }

  // If a new service no longer fits the chosen time, clear it and say why.
  useEffect(() => {
    const { data } = availability;
    if (!data || !values.preferredDate || !values.preferredTime) return;
    if (data.days[values.preferredDate]?.includes(values.preferredTime)) return;
    setValues((v) => ({ ...v, preferredTime: '' }));
    setErrors((e) => ({
      ...e,
      preferredTime: `${formatTime(values.preferredTime)} doesn’t have room for this treatment (about ${formatDuration(
        data.durationMinutes,
      )}). Please choose another time.`,
    }));
    // Only re-check when the availability data changes, not on every keystroke.
  }, [availability.data]);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors(({ [key]: _, ...rest }) => rest);
  }

  function validateMobileOnBlur() {
    if (values.mobile.trim() && !normalizePhMobile(values.mobile)) {
      setErrors((e) => ({ ...e, mobile: 'Enter a PH mobile number, e.g. 0917 123 4567.' }));
    }
  }

  function focusFirstError(fields: Record<string, string>) {
    const first = FIELD_ORDER.find((f) => fields[f]);
    if (first) focusField(formRef.current, first);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError('');

    const parsed = bookingRequestSchema().safeParse(values);
    if (!parsed.success) {
      const fields = zodFieldErrors(parsed.error);
      if (fields.preferredDate) delete fields.preferredTime; // one problem at a time: pick a day first
      setErrors(fields);
      focusFirstError(fields);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api<{
        reference: string;
        startAt: string;
        durationMinutes: number;
        dentistName: string | null;
        duplicate: boolean;
      }>('/api/bookings', { method: 'POST', body: values });
      setDone({
        firstName: parsed.data.fullName.split(/\s+/)[0],
        reference: res.reference,
        start: utcIsoToManilaLocal(res.startAt),
        durationMinutes: res.durationMinutes,
        dentistName: res.dentistName,
        mobile: parsed.data.mobile,
        duplicate: res.duplicate,
      });
      requestAnimationFrame(() => thanksRef.current?.focus());
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(err.message);
        if (err.status === 409) {
          // Someone else took the slot: show fresh times and ask for a new choice.
          setValues((v) => ({ ...v, preferredTime: '' }));
          availability.reload();
        }
        focusFirstError(err.fields);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setValues(EMPTY);
    setErrors({});
    setFormError('');
    setDone(null);
    availability.reload();
  }

  if (done) {
    const when = `${formatDateLong(done.start.slice(0, 10))} at ${formatTime(done.start.slice(11, 16))}${
      done.dentistName ? ` with ${done.dentistName}` : ''
    }`;
    return (
      <div className="booking-done" role="status">
        <span className="booking-done-check" aria-hidden="true">
          ✓
        </span>
        <h3 ref={thanksRef} tabIndex={-1}>
          Thank you, {done.firstName}.
        </h3>
        <p>
          {done.duplicate ? (
            <>
              We already have your request for <strong>{when}</strong>, so there’s no need to send it again.{' '}
            </>
          ) : (
            <>
              We’ve received your request for <strong>{when}</strong> (about {formatDuration(done.durationMinutes)}).{' '}
            </>
          )}
          Our team will call or text you at <strong>{formatPhMobile(done.mobile)}</strong> to confirm.
        </p>
        <div className="booking-ref">
          <span>Your reference</span>
          <strong>{done.reference}</strong>
          <small>Keep this to change or cancel your booking online, or mention it if you call us.</small>
        </div>
        <div className="action-row">
          <Link to={`/manage?ref=${done.reference}`} className="btn btn-secondary">
            Change or cancel
          </Link>
          <button type="button" className="btn btn-ghost" onClick={reset}>
            Make another request
          </button>
        </div>
      </div>
    );
  }

  const err = (name: string) =>
    errors[name] ? (
      <span className="field-error" id={id(`${name}-error`)}>
        <span aria-hidden="true">!</span>
        {errors[name]}
      </span>
    ) : null;
  const a11y = (name: string, hint?: string) => ({
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': [errors[name] ? id(`${name}-error`) : '', hint ?? ''].filter(Boolean).join(' ') || undefined,
  });

  return (
    <form ref={formRef} className="booking-form" onSubmit={onSubmit} noValidate aria-describedby={formError ? id('form-error') : undefined}>
      {formError && (
        <div className="alert alert-error" id={id('form-error')} role="alert">
          {formError}
        </div>
      )}

      <div className="form-row">
        <div className="field">
          <label className="field-label" htmlFor={id('fullName')}>
            Full name
          </label>
          <input
            id={id('fullName')}
            name="fullName"
            className="input"
            autoComplete="name"
            placeholder="Juan dela Cruz"
            value={values.fullName}
            onChange={(e) => set('fullName', e.target.value)}
            maxLength={100}
            {...a11y('fullName')}
          />
          {err('fullName')}
        </div>
        <div className="field">
          <label className="field-label" htmlFor={id('mobile')}>
            Mobile number
          </label>
          <input
            id={id('mobile')}
            name="mobile"
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="0917 123 4567"
            value={values.mobile}
            onChange={(e) => set('mobile', e.target.value)}
            onBlur={validateMobileOnBlur}
            maxLength={20}
            {...a11y('mobile')}
          />
          {err('mobile')}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={id('service')}>
          Reason for visit
        </label>
        <select
          id={id('service')}
          name="service"
          className="select"
          value={values.service}
          onChange={(e) => set('service', e.target.value)}
          {...a11y('service')}
        >
          {SERVICES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {err('service')}
        {values.service === 'Dental pain / urgent concern' && (
          <div className="alert alert-warn" role="note">
            <span>
              In pain right now? Please <a href={CLINIC.phoneHref}>call {CLINIC.phoneDisplay}</a> so we can see you as
              soon as possible. You can still send this request too.
            </span>
          </div>
        )}
      </div>

      {dentists.length > 1 && (
        <fieldset className="field fieldset">
          <legend className="field-label">
            Dentist <span className="field-optional">Optional</span>
          </legend>
          <div className="choice-chips" role="radiogroup">
            {[{ id: null as number | null, name: 'Any dentist', workingDays: [] as number[] }, ...dentists].map((d) => (
              <label key={d.id ?? 'any'} className={`choice-chip${values.dentistId === d.id ? ' is-active' : ''}`}>
                <input type="radio" name="dentistId" checked={values.dentistId === d.id} onChange={() => chooseDentist(d.id)} />
                <span>{d.name}</span>
                {d.id === null && <small>Most available times</small>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <SlotPicker
        idPrefix={uid}
        offDays={
          chosenDentist
            ? { weekdays: [0, 1, 2, 3, 4, 5, 6].filter((w) => !chosenDentist.workingDays.includes(w)), who: chosenDentist.name }
            : undefined
        }
        availability={availability}
        date={values.preferredDate}
        time={values.preferredTime}
        onDate={(d, closedError) => {
          setValues((v) => ({ ...v, preferredDate: d, preferredTime: '' }));
          setErrors(({ preferredDate: _d, preferredTime: _t, ...rest }) => (closedError ? { ...rest, preferredDate: closedError } : rest));
        }}
        onTime={(t) => set('preferredTime', t)}
        errors={{ preferredDate: errors.preferredDate, preferredTime: errors.preferredTime }}
        durationHint={values.service === SERVICES[0] ? undefined : values.service}
      />

      <div className="field">
        <label className="field-label" htmlFor={id('notes')}>
          Anything we should know? <span className="field-optional">Optional</span>
        </label>
        <textarea
          id={id('notes')}
          name="notes"
          className="textarea"
          rows={3}
          maxLength={NOTES_MAX}
          placeholder="e.g. sensitive tooth on the upper right, first visit for my child"
          value={values.notes}
          onChange={(e) => set('notes', e.target.value)}
          {...a11y('notes', id('notes-count'))}
        />
        <span className="field-hint field-count" id={id('notes-count')} aria-live="polite">
          {values.notes.length > NOTES_MAX - 100 ? `${NOTES_MAX - values.notes.length} characters left` : ''}
        </span>
        {err('notes')}
      </div>

      {/* Honeypot for bots: hidden from people and screen readers. */}
      <div className="hp" aria-hidden="true">
        <label>
          Website
          <input
            tabIndex={-1}
            autoComplete="off"
            name="website"
            value={values.website}
            onChange={(e) => set('website', e.target.value)}
          />
        </label>
      </div>

      <div className="field">
        <label className="consent">
          <input
            type="checkbox"
            name="consent"
            checked={values.consent}
            onChange={(e) => set('consent', e.target.checked)}
            {...a11y('consent')}
          />
          <span>
            I agree that Beatifics Dental Clinic may use these details to contact me about this request and for my dental
            care, as described in the{' '}
            <a href="/privacy" target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
              privacy policy
            </a>
            .
          </span>
        </label>
        {err('consent')}
      </div>

      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={submitting}>
        {submitting ? (
          <>
            <span className="spinner" aria-hidden="true" /> Sending request…
          </>
        ) : (
          'Request appointment'
        )}
      </button>
      <p className="form-footnote">
        This is a request. We’ll call or text you to confirm before your visit. Already booked?{' '}
        <Link to="/manage">Change or cancel</Link>
      </p>
    </form>
  );
}
