import { z } from 'zod';
import { weekdayOf } from './dates.ts';
import { closureRangesOn, fits, overlapsAny, type Closure, type TimeRange } from './schedule.ts';

/**
 * Identity colours for dentists, in fixed order (validated categorical palette: CVD-safe,
 * always shown next to the dentist's name). A new dentist gets the next unused colour.
 */
export const DENTIST_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;

export interface Dentist {
  id: number;
  name: string;
  color: string;
  /** Weekdays they work (0 = Sunday). */
  workingDays: number[];
  active: boolean;
  /** Staff account linked to this dentist, for "My schedule". */
  userId: number | null;
}

/** What the public site needs to show a dentist choice. */
export interface PublicDentist {
  id: number;
  name: string;
  workingDays: number[];
}

const workingDaysSchema = z
  .array(z.number().int().min(0).max(6), 'Choose working days.')
  .min(1, 'Choose at least one working day.')
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

export const dentistSchema = z.object({
  name: z.string('Enter a name.').trim().min(2, 'Enter a name.').max(80, 'Keep the name under 80 characters.'),
  workingDays: workingDaysSchema,
  userId: z.number().int().positive().nullable().default(null),
});

export const dentistUpdateSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter a name.').max(80).optional(),
    workingDays: workingDaysSchema.optional(),
    userId: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional(),
    color: z.enum(DENTIST_COLORS).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to update.');

/** Everything needed to decide which dentists can take a slot on one day. */
export interface DaySlotContext {
  date: string;
  dentists: Array<Pick<Dentist, 'id' | 'workingDays' | 'active'>>;
  /** Clinic-wide (dentistId null) and per-dentist closures. */
  closures: Array<Closure & { dentistId: number | null }>;
  /** Active bookings that day (excluding the one being moved). */
  bookings: Array<{ dentistId: number | null; range: TimeRange }>;
  /** Chairs: most patients the clinic can see at once. */
  capacity: number;
}

export const worksOn = (d: Pick<Dentist, 'workingDays'>, date: string) => d.workingDays.includes(weekdayOf(date));

/**
 * Dentists who can take `range`: active, working that day, not on a blocked time, not already
 * seeing someone, and the clinic still has a free chair. `only` restricts to one dentist.
 */
export function freeDentists(ctx: DaySlotContext, range: TimeRange, only: number | null = null): number[] {
  const clinicBlocked = closureRangesOn(ctx.closures.filter((c) => c.dentistId === null), ctx.date);
  if (overlapsAny(range, clinicBlocked)) return [];
  if (!fits(range, ctx.bookings.map((b) => b.range), ctx.capacity)) return [];
  return ctx.dentists
    .filter((d) => d.active && worksOn(d, ctx.date) && (only === null || d.id === only))
    .filter((d) => !overlapsAny(range, closureRangesOn(ctx.closures.filter((c) => c.dentistId === d.id), ctx.date)))
    .filter((d) => !ctx.bookings.some((b) => b.dentistId === d.id && b.range.start < range.end && b.range.end > range.start))
    .map((d) => d.id);
}

/** Pick a dentist for an "any dentist" request: the patient's regular dentist if free, else the least busy that day. */
export function chooseDentist(free: number[], regular: number | null, bookingsThatDay: Array<{ dentistId: number | null }>, order: number[]): number | null {
  if (free.length === 0) return null;
  if (regular !== null && free.includes(regular)) return regular;
  const load = (id: number) => bookingsThatDay.filter((b) => b.dentistId === id).length;
  return [...free].sort((a, b) => load(a) - load(b) || order.indexOf(a) - order.indexOf(b))[0];
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'Mon–Thu, Sat' */
export function describeWorkingDays(days: number[]): string {
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
  const runs: number[][] = [];
  for (const d of order) {
    const last = runs.at(-1);
    const prev = last?.at(-1);
    const next = prev === undefined ? -1 : prev === 6 ? 0 : prev + 1;
    if (last && d === next && prev !== 0) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length >= 3 ? `${WEEKDAY_SHORT[r[0]]}–${WEEKDAY_SHORT[r.at(-1)!]}` : r.map((d) => WEEKDAY_SHORT[d]).join(', ')))
    .join(', ');
}
