import { z } from 'zod';
import { isBookableDate, isDateString, manilaLocalToUtcIso } from './dates.ts';
import { durationSchema, isTimeString } from './schedule.ts';

import { SERVICES, type Service } from './constants.ts';

export { CLINIC, SERVICES, type Service } from './constants.ts';

export const STATUSES = ['pending', 'confirmed', 'completed', 'no_show', 'cancelled'] as const;
export type BookingStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  completed: 'Completed',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};

/** Allowed status changes. Completed and no-show are final; a cancelled request can be reopened. */
export const STATUS_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'no_show', 'cancelled'],
  cancelled: ['pending'],
  completed: [],
  no_show: [],
};

/** Staying in the same status is always allowed (e.g. saving notes, rescheduling). */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return from === to || STATUS_TRANSITIONS[from].includes(to);
}

// ---- Phone numbers ----

/** Normalise a Philippine mobile number to '09XXXXXXXXX', or null if invalid. */
export function normalizePhMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  let m = /^\+?63(9\d{9})$/.exec(digits);
  if (m) return `0${m[1]}`;
  m = /^(09\d{9})$/.exec(digits);
  return m ? m[1] : null;
}

/** '09171234567' → '0917 123 4567' */
export function formatPhMobile(mobile: string): string {
  return /^09\d{9}$/.test(mobile) ? `${mobile.slice(0, 4)} ${mobile.slice(4, 7)} ${mobile.slice(7)}` : mobile;
}

// ---- Public booking request ----

export const NOTES_MAX = 500;

/** `who` is 'your' for patients and 'the patient’s' for staff, so messages read naturally. */
const fullNameSchema = (who: string) =>
  z
    .string(`Please enter ${who} full name.`)
    .trim()
    .min(2, `Please enter ${who} full name.`)
    .max(100, 'Please keep the name under 100 characters.');

const mobileSchema = (who: string) =>
  z
    .string(`Please enter ${who} mobile number.`)
    .trim()
    .min(1, `Please enter ${who} mobile number.`)
    .transform((v, ctx) => {
      const n = normalizePhMobile(v);
      if (!n) {
        ctx.addIssue({ code: 'custom', message: 'Enter a PH mobile number, e.g. 0917 123 4567.' });
        return z.NEVER;
      }
      return n;
    });

const serviceSchema = z.enum(SERVICES, 'Please choose a reason for the visit.');

/** Patient reschedules their own booking to another free slot. */
export function rescheduleSchema(now: Date = new Date()) {
  return z.object({
    preferredDate: z
      .string('Please choose a day.')
      .refine((d) => isDateString(d) && isBookableDate(d, now), 'Please choose an available clinic day.'),
    preferredTime: z.string('Please choose a time.').refine(isTimeString, 'Please choose a time.'),
  });
}

export function bookingRequestSchema(now: Date = new Date()) {
  return z.object({
    fullName: fullNameSchema('your'),
    mobile: mobileSchema('your'),
    service: serviceSchema,
    preferredDate: z
      .string('Please choose a day.')
      .refine((d) => isDateString(d) && isBookableDate(d, now), 'Please choose an available clinic day.'),
    /** Manila 'HH:mm'. Whether the slot is actually free is checked on the server. */
    preferredTime: z.string('Please choose a time.').refine(isTimeString, 'Please choose a time.'),
    /** A specific dentist, or null for "any dentist". */
    dentistId: z.number().int().positive().nullable().default(null),
    notes: z.string().trim().max(NOTES_MAX, `Please keep notes under ${NOTES_MAX} characters.`).default(''),
    consent: z.literal(true, 'Please agree so we can contact you about your request.'),
  });
}
export type BookingRequestInput = z.input<ReturnType<typeof bookingRequestSchema>>;
export type BookingRequest = z.output<ReturnType<typeof bookingRequestSchema>>;

// ---- Admin update ----

export const STAFF_NOTES_MAX = 2000;

export const bookingUpdateSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    /** Manila local 'YYYY-MM-DDTHH:mm' */
    startAt: z
      .string()
      .refine((v) => manilaLocalToUtcIso(v) !== null, 'Enter a valid date and time.')
      .optional(),
    durationMinutes: durationSchema.optional(),
    /** Assign to a dentist, or null to unassign. */
    dentistId: z.number().int().positive().nullable().optional(),
    staffNotes: z.string().max(STAFF_NOTES_MAX, `Notes are limited to ${STAFF_NOTES_MAX} characters.`).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update.');
export type BookingUpdate = z.infer<typeof bookingUpdateSchema>;

/**
 * Appointment added by staff (phone call, walk-in). Staff may book any time and go over
 * capacity; the portal warns them first. Consent is collected verbally by staff.
 */
export const staffBookingSchema = z.object({
  fullName: fullNameSchema('the patient’s'),
  mobile: mobileSchema('the patient’s'),
  service: serviceSchema,
  /** Manila local 'YYYY-MM-DDTHH:mm' */
  startAt: z.string('Choose a date and time.').refine((v) => manilaLocalToUtcIso(v) !== null, 'Choose a valid date and time.'),
  durationMinutes: durationSchema,
  dentistId: z.number().int().positive().nullable().default(null),
  status: z.enum(['confirmed', 'pending']).default('confirmed'),
  staffNotes: z.string().trim().max(STAFF_NOTES_MAX, `Notes are limited to ${STAFF_NOTES_MAX} characters.`).default(''),
});
export type StaffBookingInput = z.input<typeof staffBookingSchema>;
export type StaffBooking = z.output<typeof staffBookingSchema>;

// ---- API shapes ----

export interface Booking {
  id: number;
  reference: string;
  fullName: string;
  mobile: string;
  service: Service;
  notes: string;
  status: BookingStatus;
  /** Appointment start, UTC ISO. Chosen by the patient; staff may change it. */
  startAt: string;
  durationMinutes: number;
  /** Assigned dentist, or null if unassigned. */
  dentistId: number | null;
  /** True when the patient asked for this dentist specifically (so staff should keep them). */
  dentistRequested: boolean;
  staffNotes: string;
  /** 'online' = requested by the patient on the website, 'staff' = added in the admin portal */
  source: 'online' | 'staff';
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

/** Summary of a patient's other bookings (matched by mobile number). */
export interface PatientSummary {
  /** Earlier bookings that weren't cancelled. 0 = new patient. */
  previousVisits: number;
  noShows: number;
}

export type BookingListItem = Booking & { patient: PatientSummary };

export type BookingView = 'action' | 'today' | 'upcoming' | 'all';

export interface BookingListResponse {
  bookings: BookingListItem[];
  counts: Record<BookingView, number>;
}

export interface BookingDetailResponse {
  booking: Booking;
  /** Other bookings with the same mobile, newest first. */
  history: Booking[];
  activity: AuditEntry[];
}

/** A booking as shown in a day's schedule (no contact details). */
export interface ScheduleEntry {
  id: number;
  fullName: string;
  service: Service;
  status: BookingStatus;
  startAt: string;
  durationMinutes: number;
  dentistId: number | null;
}

// ---- Staff accounts ----

export const ROLES = ['admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = { admin: 'Admin', staff: 'Staff' };
export const ROLE_HINTS: Record<Role, string> = {
  admin: 'Everything, including settings and staff accounts',
  staff: 'Bookings, calendar, blocked times and reports',
};

export interface StaffUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  /** Set when this account belongs to a dentist: their views default to "my patients". */
  dentistId: number | null;
}

export interface StaffAccount extends StaffUser {
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const PASSWORD_MIN = 10;
const passwordSchema = z
  .string('Enter a password.')
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(200, 'That password is too long.');

export const newUserSchema = z.object({
  name: z.string('Enter a name.').trim().min(1, 'Enter a name.').max(80),
  email: z.string('Enter an email.').trim().toLowerCase().email('Enter a valid email.').max(200),
  role: z.enum(ROLES).default('staff'),
  password: passwordSchema,
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(80).optional(),
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional(),
    password: passwordSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update.');

export const changePasswordSchema = z.object({
  currentPassword: z.string('Enter your current password.').min(1, 'Enter your current password.'),
  newPassword: passwordSchema,
});

// ---- Activity log ----

export interface AuditEntry {
  id: number;
  at: string;
  actorType: 'patient' | 'staff';
  /** Staff name, or 'Patient' */
  actor: string;
  action: string;
  bookingId: number | null;
  /** Human-readable, e.g. 'Confirmed for Wed, 7 Oct, 9:00 AM' */
  summary: string;
}

export interface UpdatesResponse {
  serverTime: string;
  pending: number;
  /** Patient actions since the given time: new requests, cancellations, reschedules. */
  events: AuditEntry[];
}

// ---- Patient self-service ----

export const manageLookupSchema = z.object({
  reference: z
    .string('Enter your booking reference.')
    .trim()
    .toUpperCase()
    .transform((v) => (v.startsWith('BD-') ? v : `BD-${v}`))
    .refine((v) => /^BD-[A-Z0-9]{5}$/.test(v), 'Enter the reference from your confirmation, e.g. BD-7K3Q9.'),
  mobile: mobileSchema('your'),
});

/** What a patient sees about their own booking: no staff notes or internal fields. */
export interface PublicBooking {
  reference: string;
  firstName: string;
  service: Service;
  status: BookingStatus;
  startAt: string;
  durationMinutes: number;
  /** Dentist's name, if assigned. */
  dentistName: string | null;
  /** Whether the patient may still change or cancel online (until the day before). */
  canChange: boolean;
}

// ---- Reports ----

export interface ReportsResponse {
  from: string;
  to: string;
  totals: {
    requestsOnline: number;
    addedByStaff: number;
    appointments: number;
    completed: number;
    noShows: number;
    cancelled: number;
    newPatients: number;
    returningPatients: number;
  };
  byService: Array<{ service: Service; count: number }>;
  /** Appointments per dentist; dentistId null = unassigned. */
  byDentist: Array<{ dentistId: number | null; name: string; count: number }>;
  byWeekday: Array<{ weekday: number; count: number }>;
  byHour: Array<{ hour: number; count: number }>;
}

/** Field-level validation errors returned by the API with status 400. */
export interface ValidationErrorResponse {
  error: string;
  fields?: Record<string, string>;
}

export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}
