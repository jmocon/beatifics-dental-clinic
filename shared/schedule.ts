import { z } from 'zod';
import { SERVICES, type Service } from './constants.ts';
import { addDays, CLINIC_HOURS, isDateString, manilaLocalToUtcIso, weekdayOf } from './dates.ts';

// ---- Clinic settings (editable by admins) ----

export interface ClinicSettings {
  /** Default length of one patient's appointment, in minutes. New requests get this length. */
  appointmentMinutes: number;
  /** How many patients the clinic can see at the same time (chairs/dentists). */
  capacity: number;
  /** Optional length per service; services not listed use `appointmentMinutes`. */
  serviceMinutes: Partial<Record<Service, number>>;
}

export const DEFAULT_SETTINGS: ClinicSettings = { appointmentMinutes: 60, capacity: 2, serviceMinutes: {} };

/** How long a booking for `service` reserves. */
export function durationFor(settings: ClinicSettings, service: string): number {
  return settings.serviceMinutes[service as Service] ?? settings.appointmentMinutes;
}

export const MIN_DURATION = 15;
export const MAX_DURATION = 240;
export const MAX_CAPACITY = 10;

/** Patients can start an appointment every 30 minutes. */
export const SLOT_STEP_MINUTES = 30;

const durationSchema = z
  .number('Choose a length.')
  .int()
  .min(MIN_DURATION, `The shortest length is ${MIN_DURATION} minutes.`)
  .max(MAX_DURATION, `The longest length is ${MAX_DURATION / 60} hours.`)
  .refine((m) => m % 15 === 0, 'Use 15-minute steps.');

export const settingsSchema = z.object({
  appointmentMinutes: durationSchema,
  capacity: z
    .number('Enter a number.')
    .int('Enter a whole number.')
    .min(1, 'At least 1 patient.')
    .max(MAX_CAPACITY, `At most ${MAX_CAPACITY} patients.`),
  serviceMinutes: z.partialRecord(z.enum(SERVICES), durationSchema).default({}),
});

export { durationSchema };

/** Choices offered in duration pickers. */
export const DURATION_OPTIONS = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240];

// ---- Times ----

/** 'HH:mm' → minutes since midnight */
export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** minutes since midnight → 'HH:mm' */
export function fromMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function isTimeString(value: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return !!m && +m[1] < 24 && +m[2] < 60;
}

/** '13:30' → '1:30 PM' */
export function formatTime(time: string): string {
  const mins = toMinutes(time);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 90 → '1 h 30 min', 60 → '1 hour', 45 → '45 min' */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${m} min`;
}

/** Start times a patient may choose on a date (before taking existing bookings into account). */
export function dailySlots(date: string, durationMinutes: number): string[] {
  if (!isDateString(date)) return [];
  const hours = CLINIC_HOURS[weekdayOf(date)];
  if (!hours) return [];
  const slots: string[] = [];
  for (let t = hours.open * 60; t + durationMinutes <= hours.close * 60; t += SLOT_STEP_MINUTES) {
    slots.push(fromMinutes(t));
  }
  return slots;
}

// ---- Capacity ----

export interface TimeRange {
  /** UTC ms */
  start: number;
  /** UTC ms (exclusive) */
  end: number;
}

export function rangeOf(startIso: string, durationMinutes: number): TimeRange {
  const start = new Date(startIso).getTime();
  return { start, end: start + durationMinutes * 60_000 };
}

/** Manila 'YYYY-MM-DD' + 'HH:mm' → time range */
export function slotRange(date: string, time: string, durationMinutes: number): TimeRange {
  return rangeOf(manilaLocalToUtcIso(`${date}T${time}`)!, durationMinutes);
}

/** Greatest number of `existing` appointments running at the same moment within `range`. */
export function maxOverlap(range: TimeRange, existing: TimeRange[]): number {
  const overlapping = existing.filter((r) => r.start < range.end && r.end > range.start);
  if (overlapping.length === 0) return 0;
  // Concurrency only rises at a start point, so checking those points is enough.
  const points = [range.start, ...overlapping.map((r) => r.start).filter((s) => s > range.start && s < range.end)];
  let max = 0;
  for (const p of points) {
    const n = overlapping.filter((r) => r.start <= p && r.end > p).length;
    if (n > max) max = n;
  }
  return max;
}

/** Can one more patient fit in `range` without exceeding capacity? */
export function fits(range: TimeRange, existing: TimeRange[], capacity: number): boolean {
  return maxOverlap(range, existing) < capacity;
}

// ---- Closures & blocked times ----

export const CLOSURE_REPEATS = ['none', 'daily', 'weekly'] as const;
export type ClosureRepeat = (typeof CLOSURE_REPEATS)[number];

export interface Closure {
  id: number;
  /** First day it applies (Manila). */
  startDate: string;
  /** Last day it applies; null = same as startDate when not repeating, or forever when repeating. */
  endDate: string | null;
  repeat: ClosureRepeat;
  /** 'HH:mm' or null for the whole day */
  startTime: string | null;
  endTime: string | null;
  reason: string;
  /** null = the whole clinic; otherwise only this dentist is unavailable. */
  dentistId: number | null;
}

export const closureSchema = z
  .object({
    startDate: z.string('Choose a date.').refine(isDateString, 'Choose a date.'),
    endDate: z
      .string()
      .refine(isDateString, 'Choose a valid end date.')
      .nullable()
      .default(null),
    repeat: z.enum(CLOSURE_REPEATS).default('none'),
    startTime: z.string().refine(isTimeString, 'Choose a start time.').nullable().default(null),
    endTime: z.string().refine(isTimeString, 'Choose an end time.').nullable().default(null),
    reason: z.string().trim().max(100, 'Keep the reason short.').default(''),
    dentistId: z.number().int().positive().nullable().default(null),
  })
  .refine((c) => c.endDate === null || c.endDate >= c.startDate, { message: 'The end date is before the start date.', path: ['endDate'] })
  .refine((c) => (c.startTime === null) === (c.endTime === null), { message: 'Set both a start and an end time, or neither.', path: ['endTime'] })
  .refine((c) => c.startTime === null || c.endTime === null || c.endTime > c.startTime, {
    message: 'The end time must be after the start time.',
    path: ['endTime'],
  });
export type ClosureInput = z.input<typeof closureSchema>;

/** Does this closure apply on a given Manila date? */
export function closureAppliesOn(c: Pick<Closure, 'startDate' | 'endDate' | 'repeat'>, date: string): boolean {
  if (date < c.startDate) return false;
  if (c.repeat === 'none') return date <= (c.endDate ?? c.startDate);
  if (c.endDate && date > c.endDate) return false;
  return c.repeat === 'daily' || weekdayOf(date) === weekdayOf(c.startDate);
}

/** The blocked time ranges on a date. Whole-day closures cover midnight to midnight. */
export function closureRangesOn(closures: Closure[], date: string): TimeRange[] {
  return closures
    .filter((c) => closureAppliesOn(c, date))
    .map((c) => {
      const start = manilaLocalToUtcIso(`${date}T${c.startTime ?? '00:00'}`)!;
      const end = c.endTime ? manilaLocalToUtcIso(`${date}T${c.endTime}`)! : manilaLocalToUtcIso(`${addDays(date, 1)}T00:00`)!;
      return { start: new Date(start).getTime(), end: new Date(end).getTime() };
    });
}

export function overlapsAny(range: TimeRange, blocked: TimeRange[]): boolean {
  return blocked.some((b) => b.start < range.end && b.end > range.start);
}

/** Human description: 'All day', '12:00 – 1:00 PM'; plus repeat text. */
export function describeClosure(c: Pick<Closure, 'startDate' | 'endDate' | 'repeat' | 'startTime' | 'endTime'>): {
  when: string;
  time: string;
} {
  const time = c.startTime && c.endTime ? `${formatTime(c.startTime)} – ${formatTime(c.endTime)}` : 'All day';
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  let when: string;
  if (c.repeat === 'daily') when = `Every day from ${fmt(c.startDate)}${c.endDate ? ` to ${fmt(c.endDate)}` : ''}`;
  else if (c.repeat === 'weekly')
    when = `Every ${new Date(`${c.startDate}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', weekday: 'long' })}${
      c.endDate ? ` until ${fmt(c.endDate)}` : ''
    }`;
  else when = c.endDate && c.endDate !== c.startDate ? `${fmt(c.startDate)} – ${fmt(c.endDate)}` : fmt(c.startDate);
  return { when, time };
}

// ---- Calendar layout ----

/**
 * Place overlapping appointments side by side (like a desktop calendar).
 * Returns, per item, its lane index and how many lanes its overlap group uses.
 */
export function layoutLanes<T extends { start: number; end: number }>(items: T[]): Array<T & { lane: number; lanes: number }> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Array<T & { lane: number; lanes: number }> = [];
  let group: Array<T & { lane: number; lanes: number }> = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const lanes = Math.max(1, ...group.map((g) => g.lane + 1));
    for (const g of group) g.lanes = lanes;
    out.push(...group);
    group = [];
  };
  for (const item of sorted) {
    if (item.start >= groupEnd && group.length) flush();
    const laneEnds: number[] = [];
    for (const g of group) laneEnds[g.lane] = Math.max(laneEnds[g.lane] ?? -Infinity, g.end);
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) lane = laneEnds.length;
    group.push({ ...item, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, item.end);
  }
  if (group.length) flush();
  return out;
}

// ---- API shapes ----

export interface AvailabilityResponse {
  durationMinutes: number;
  /** Bookable clinic days → free start times ('HH:mm'). Days with no free times have an empty list. */
  days: Record<string, string[]>;
}
