// All clinic dates are in Asia/Manila (UTC+8, no daylight saving).
// Calendar dates are plain 'YYYY-MM-DD' strings; instants are UTC ISO strings.

export const CLINIC_TZ = 'Asia/Manila';
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Clinic opening hours by weekday (0 = Sunday). `null` = closed. */
export const CLINIC_HOURS: Record<number, { open: number; close: number } | null> = {
  0: null,
  1: { open: 9, close: 17 },
  2: { open: 9, close: 17 },
  3: { open: 9, close: 17 },
  4: { open: 9, close: 17 },
  5: null,
  6: { open: 9, close: 17 },
};

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateString(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function dateToUtc(date: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}

function utcToDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in Manila. */
export function manilaToday(now: Date = new Date()): string {
  return utcToDate(new Date(now.getTime() + MANILA_OFFSET_MS));
}

/** Current hour (0–23) in Manila. */
export function manilaHour(now: Date = new Date()): number {
  return new Date(now.getTime() + MANILA_OFFSET_MS).getUTCHours();
}

export function addDays(date: string, days: number): string {
  const d = dateToUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return utcToDate(d);
}

export function weekdayOf(date: string): number {
  return dateToUtc(date).getUTCDay();
}

export function isClinicDay(date: string): boolean {
  return isDateString(date) && CLINIC_HOURS[weekdayOf(date)] !== null;
}

/** How far ahead patients may request, in days. */
export const BOOKING_WINDOW_DAYS = 60;

/** First and last dates a patient may request (requests start from tomorrow). */
export function bookingWindow(now: Date = new Date()): { first: string; last: string } {
  const today = manilaToday(now);
  return { first: addDays(today, 1), last: addDays(today, BOOKING_WINDOW_DAYS) };
}

export function isBookableDate(date: string, now: Date = new Date()): boolean {
  if (!isClinicDay(date)) return false;
  const { first, last } = bookingWindow(now);
  return date >= first && date <= last;
}

/** The next `count` bookable clinic days, starting tomorrow. */
export function upcomingClinicDays(count: number, now: Date = new Date()): string[] {
  const days: string[] = [];
  let d = bookingWindow(now).first;
  while (days.length < count) {
    if (isClinicDay(d)) days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

/** 'YYYY-MM-DDTHH:mm' in Manila local time → UTC ISO string. */
export function manilaLocalToUtcIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m || !isDateString(`${m[1]}-${m[2]}-${m[3]}`)) return null;
  const hh = +m[4];
  const mm = +m[5];
  if (hh > 23 || mm > 59) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], hh, mm) - MANILA_OFFSET_MS;
  return new Date(ms).toISOString();
}

/** UTC ISO string → 'YYYY-MM-DDTHH:mm' in Manila local time (for <input type="datetime-local">). */
export function utcIsoToManilaLocal(iso: string): string {
  return new Date(new Date(iso).getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 16);
}

/** Is a Manila-local datetime inside clinic opening hours? */
export function isWithinClinicHours(local: string): boolean {
  const date = local.slice(0, 10);
  if (!isDateString(date)) return false;
  const hours = CLINIC_HOURS[weekdayOf(date)];
  if (!hours) return false;
  const [hh, mm] = local.slice(11, 16).split(':').map(Number);
  const minutes = hh * 60 + mm;
  return minutes >= hours.open * 60 && minutes < hours.close * 60;
}

// ---- Display formatting (always Manila) ----

/** 'Monday, 12 October' (adds the year if it differs from this year). */
export function formatDateLong(date: string, now: Date = new Date()): string {
  const d = dateToUtc(date);
  const sameYear = date.slice(0, 4) === manilaToday(now).slice(0, 4);
  return d.toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** 'Mon, 12 Oct' */
export function formatDateShort(date: string): string {
  return dateToUtc(date).toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** 'Mon, 12 Oct, 9:30 AM' for a UTC instant, shown in Manila time. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: CLINIC_TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Relative description like 'Today', 'Tomorrow', 'In 3 days', 'Yesterday', '2 days ago'. */
export function relativeDay(date: string, now: Date = new Date()): string {
  const diff = Math.round((dateToUtc(date).getTime() - dateToUtc(manilaToday(now)).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return diff > 0 ? `In ${diff} days` : `${-diff} days ago`;
}

/** '5 min ago', '3 h ago', '2 d ago' for a UTC instant. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}
