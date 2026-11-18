import { randomInt } from 'node:crypto';
import type {
  Booking,
  BookingListItem,
  BookingRequest,
  BookingStatus,
  BookingView,
  ReportsResponse,
  ScheduleEntry,
  Service,
  StaffBooking,
} from '../shared/booking.ts';
import { SERVICES } from '../shared/constants.ts';
import { addDays, bookingWindow, isClinicDay, manilaLocalToUtcIso, manilaToday, utcIsoToManilaLocal, weekdayOf } from '../shared/dates.ts';
import { chooseDentist, freeDentists, type Dentist } from '../shared/dentists.ts';
import {
  closureRangesOn,
  dailySlots,
  durationFor,
  fits,
  overlapsAny,
  rangeOf,
  slotRange,
  type AvailabilityResponse,
  type ClinicSettings,
  type Closure,
  type TimeRange,
} from '../shared/schedule.ts';
import type { Db } from './db.ts';

interface BookingRow {
  id: number;
  reference: string;
  full_name: string;
  mobile: string;
  service: string;
  notes: string;
  status: string;
  start_at: string;
  duration_minutes: number;
  dentist_id: number | null;
  dentist_requested: number;
  staff_notes: string;
  source: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    reference: r.reference,
    fullName: r.full_name,
    mobile: r.mobile,
    service: r.service as Service,
    notes: r.notes,
    status: r.status as BookingStatus,
    startAt: r.start_at,
    durationMinutes: Number(r.duration_minutes),
    dentistId: r.dentist_id,
    dentistRequested: r.dentist_requested === 1,
    staffNotes: r.staff_notes,
    source: r.source as Booking['source'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** Bookings that occupy a chair: requests waiting for confirmation and confirmed appointments. */
const ACTIVE = "status IN ('pending', 'confirmed')";

// No 0/O, 1/I/L so references are easy to read out over the phone.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newReference(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `BD-${s}`;
}

/** UTC ISO bounds of a Manila calendar day (end exclusive). */
export function manilaDayRangeUtc(date: string): { start: string; end: string } {
  return {
    start: manilaLocalToUtcIso(`${date}T00:00`)!,
    end: manilaLocalToUtcIso(`${addDays(date, 1)}T00:00`)!,
  };
}

export function getBooking(db: Db, id: number): Booking | null {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

// ---- Availability ----

/** What decides whether a time can be booked: settings, blocked times and the active dentists. */
export interface SlotEnv {
  settings: ClinicSettings;
  closures: Closure[];
  /** Active dentists. Empty = the clinic hasn't set up dentists; only chairs (capacity) count. */
  dentists: Dentist[];
}

type ActiveBooking = { dentistId: number | null; range: TimeRange };

/** Active bookings starting between two UTC instants. */
function activeBookings(db: Db, fromIso: string, toIso: string, excludeId?: number): ActiveBooking[] {
  const rows = db
    .prepare(`SELECT start_at, duration_minutes, dentist_id FROM bookings WHERE ${ACTIVE} AND start_at >= ? AND start_at < ? AND id != ?`)
    .all(fromIso, toIso, excludeId ?? -1) as Array<{ start_at: string; duration_minutes: number; dentist_id: number | null }>;
  return rows.map((r) => ({ dentistId: r.dentist_id, range: rangeOf(r.start_at, Number(r.duration_minutes)) }));
}

/** Can the slot be booked, and by which dentists? */
function checkSlot(env: SlotEnv, date: string, range: TimeRange, bookings: ActiveBooking[], only: number | null) {
  if (env.dentists.length === 0) {
    const blocked = closureRangesOn(env.closures.filter((c) => c.dentistId === null), date);
    const ok = !overlapsAny(range, blocked) && fits(range, bookings.map((b) => b.range), env.settings.capacity);
    return { ok, free: [] as number[] };
  }
  const free = freeDentists(
    { date, dentists: env.dentists, closures: env.closures, bookings, capacity: env.settings.capacity },
    range,
    only,
  );
  return { ok: free.length > 0, free };
}

/** Free start times for every bookable day in the patient booking window. */
export function getAvailability(
  db: Db,
  env: SlotEnv,
  opts: { service: string; duration?: number; excludeId?: number; dentistId?: number | null },
  now: Date,
): AvailabilityResponse {
  const duration = opts.duration ?? durationFor(env.settings, opts.service);
  const { first, last } = bookingWindow(now);
  const bookings = activeBookings(db, manilaDayRangeUtc(first).start, manilaDayRangeUtc(last).end, opts.excludeId);
  const days: Record<string, string[]> = {};
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!isClinicDay(d)) continue;
    days[d] = dailySlots(d, duration).filter((t) => checkSlot(env, d, slotRange(d, t, duration), bookings, opts.dentistId ?? null).ok);
  }
  return { durationMinutes: duration, days };
}

/**
 * Check a slot and pick who takes it. `only` = the dentist the patient asked for;
 * otherwise the `preferred` (regular) dentist if free, else the least busy one that day.
 */
export function pickSlot(
  db: Db,
  env: SlotEnv,
  date: string,
  time: string,
  duration: number,
  opts: { excludeId?: number; only?: number | null; preferred?: number | null } = {},
): { ok: boolean; dentistId: number | null } {
  if (!dailySlots(date, duration).includes(time)) return { ok: false, dentistId: null };
  const day = manilaDayRangeUtc(date);
  const bookings = activeBookings(db, day.start, day.end, opts.excludeId);
  const check = checkSlot(env, date, slotRange(date, time, duration), bookings, opts.only ?? null);
  if (!check.ok) return { ok: false, dentistId: null };
  if (env.dentists.length === 0) return { ok: true, dentistId: null };
  return {
    ok: true,
    dentistId: chooseDentist(check.free, opts.preferred ?? null, bookings, env.dentists.map((d) => d.id)),
  };
}

/** The dentist a patient last saw (or is confirmed with), to keep them together. */
export function regularDentist(db: Db, mobile: string): number | null {
  const row = db
    .prepare(
      `SELECT dentist_id FROM bookings WHERE mobile = ? AND dentist_id IS NOT NULL
       AND status IN ('confirmed', 'completed') ORDER BY start_at DESC LIMIT 1`,
    )
    .get(mobile) as { dentist_id: number } | undefined;
  return row?.dentist_id ?? null;
}

// ---- Creating ----

export type CreateResult = { booking: Booking; duplicate: boolean } | { slotTaken: true };

/**
 * Store a booking request for a free slot. If the same mobile already has a pending
 * request that day, that one is returned instead, so double-submits don't create duplicates.
 * (node:sqlite is synchronous, so the check and the insert can't interleave with another request.)
 */
export function createBooking(db: Db, req: BookingRequest, env: SlotEnv, now: Date): CreateResult {
  const day = manilaDayRangeUtc(req.preferredDate);
  const existing = db
    .prepare("SELECT * FROM bookings WHERE mobile = ? AND status = 'pending' AND start_at >= ? AND start_at < ?")
    .get(req.mobile, day.start, day.end) as BookingRow | undefined;
  if (existing) return { booking: toBooking(existing), duplicate: true };

  const duration = durationFor(env.settings, req.service);
  const slot = pickSlot(db, env, req.preferredDate, req.preferredTime, duration, {
    only: req.dentistId,
    preferred: regularDentist(db, req.mobile),
  });
  if (!slot.ok) return { slotTaken: true };

  const booking = insertBooking(
    db,
    {
      fullName: req.fullName,
      mobile: req.mobile,
      service: req.service,
      notes: req.notes,
      startAt: manilaLocalToUtcIso(`${req.preferredDate}T${req.preferredTime}`)!,
      durationMinutes: duration,
      dentistId: slot.dentistId,
      dentistRequested: req.dentistId !== null && env.dentists.length > 0,
      status: 'pending',
      staffNotes: '',
      source: 'online',
      createdBy: null,
    },
    now,
  );
  return { booking, duplicate: false };
}

/** Appointment entered by staff, e.g. booked over the phone or a walk-in. */
export function createStaffBooking(db: Db, input: StaffBooking, staffName: string, now: Date): Booking {
  return insertBooking(
    db,
    {
      fullName: input.fullName,
      mobile: input.mobile,
      service: input.service,
      notes: '',
      startAt: manilaLocalToUtcIso(input.startAt)!,
      durationMinutes: input.durationMinutes,
      dentistId: input.dentistId,
      dentistRequested: false,
      status: input.status,
      staffNotes: input.staffNotes,
      source: 'staff',
      createdBy: staffName,
    },
    now,
  );
}

function insertBooking(
  db: Db,
  b: {
    fullName: string;
    mobile: string;
    service: string;
    notes: string;
    startAt: string;
    durationMinutes: number;
    dentistId: number | null;
    dentistRequested: boolean;
    status: BookingStatus;
    staffNotes: string;
    source: Booking['source'];
    createdBy: string | null;
  },
  now: Date,
): Booking {
  const insert = db.prepare(
    `INSERT INTO bookings (reference, full_name, mobile, service, notes, start_at, duration_minutes, dentist_id,
                           dentist_requested, status, staff_notes, source, created_at, updated_at, updated_by)
     VALUES (:reference, :fullName, :mobile, :service, :notes, :startAt, :durationMinutes, :dentistId,
             :dentistRequested, :status, :staffNotes, :source, :ts, :ts, :createdBy)`,
  );
  for (let attempt = 0; ; attempt++) {
    try {
      const result = insert.run({
        ...b,
        dentistRequested: b.dentistRequested ? 1 : 0,
        reference: newReference(),
        ts: now.toISOString(),
      });
      return getBooking(db, Number(result.lastInsertRowid))!;
    } catch (err) {
      // Retry on the (very unlikely) reference collision.
      if (attempt < 5 && String(err).includes('UNIQUE') && String(err).includes('reference')) continue;
      throw err;
    }
  }
}

// ---- Lists ----

/** Filter by dentist: an id, 'unassigned', or null for everyone. */
export type DentistFilter = number | 'unassigned' | null;

function viewFilter(view: BookingView, now: Date): { where: string; params: Record<string, string | number>; order: string } {
  const today = manilaDayRangeUtc(manilaToday(now));
  switch (view) {
    case 'action':
      return { where: "b.status = 'pending'", params: {}, order: 'b.start_at ASC, b.created_at ASC' };
    case 'today':
      return {
        where: "b.status = 'confirmed' AND b.start_at >= :todayStart AND b.start_at < :todayEnd",
        params: { todayStart: today.start, todayEnd: today.end },
        order: 'b.start_at ASC',
      };
    case 'upcoming':
      return {
        where: "b.status = 'confirmed' AND b.start_at >= :todayStart",
        params: { todayStart: today.start },
        order: 'b.start_at ASC',
      };
    case 'all':
      return { where: '1 = 1', params: {}, order: 'b.created_at DESC' };
  }
}

function dentistClause(filter: DentistFilter, params: Record<string, string | number>): string {
  if (filter === null) return '';
  if (filter === 'unassigned') return ' AND b.dentist_id IS NULL';
  params.dentistId = filter;
  return ' AND b.dentist_id = :dentistId';
}

export const BOOKING_VIEWS: BookingView[] = ['action', 'today', 'upcoming', 'all'];

export function listBookings(db: Db, view: BookingView, query: string, now: Date, dentist: DentistFilter = null): BookingListItem[] {
  const f = viewFilter(view, now);
  const params: Record<string, string | number> = { ...f.params };
  let where = f.where + dentistClause(dentist, params);

  const q = query.trim();
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    params.q = `%${escaped}%`;
    const digits = q.replace(/\D/g, '');
    let mobileClause = '';
    if (digits.length >= 3) {
      // Let staff search '+63 917…' or '917 123' against the stored '0917…'.
      params.qDigits = `%${digits.replace(/^63(?=9)/, '0')}%`;
      mobileClause = " OR b.mobile LIKE :qDigits ESCAPE '\\'";
    }
    where += ` AND (b.full_name LIKE :q ESCAPE '\\' OR b.reference LIKE :q ESCAPE '\\'${mobileClause})`;
  }

  const rows = db
    .prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM bookings p WHERE p.mobile = b.mobile AND p.id != b.id
            AND p.status != 'cancelled' AND p.start_at < b.start_at) AS prev_visits,
         (SELECT COUNT(*) FROM bookings p WHERE p.mobile = b.mobile AND p.id != b.id AND p.status = 'no_show') AS no_shows
       FROM bookings b WHERE ${where} ORDER BY ${f.order} LIMIT 500`,
    )
    .all(params) as unknown as Array<BookingRow & { prev_visits: number; no_shows: number }>;
  return rows.map((r) => ({
    ...toBooking(r),
    patient: { previousVisits: Number(r.prev_visits), noShows: Number(r.no_shows) },
  }));
}

export function countBookings(db: Db, now: Date, dentist: DentistFilter = null): Record<BookingView, number> {
  const counts = {} as Record<BookingView, number>;
  for (const view of BOOKING_VIEWS) {
    const f = viewFilter(view, now);
    const params = { ...f.params };
    const where = f.where + dentistClause(dentist, params);
    const row = db.prepare(`SELECT COUNT(*) AS n FROM bookings b WHERE ${where}`).get(params) as { n: number };
    counts[view] = Number(row.n);
  }
  return counts;
}

export function countPending(db: Db): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending'").get() as { n: number }).n);
}

/** Upcoming active bookings with no dentist yet (e.g. made before dentists were set up). */
export function countUnassignedUpcoming(db: Db, now: Date): number {
  const start = manilaDayRangeUtc(manilaToday(now)).start;
  return Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE ${ACTIVE} AND dentist_id IS NULL AND start_at >= ?`).get(start) as { n: number }).n,
  );
}

/**
 * Give each upcoming unassigned booking to a dentist who is actually free then (their regular
 * dentist first, else the least busy). Bookings no dentist can take stay unassigned for staff.
 */
export function autoAssignUnassigned(db: Db, env: SlotEnv, by: string, now: Date): { assigned: number; left: number } {
  const start = manilaDayRangeUtc(manilaToday(now)).start;
  const rows = db
    .prepare(`SELECT * FROM bookings WHERE ${ACTIVE} AND dentist_id IS NULL AND start_at >= ? ORDER BY start_at, id`)
    .all(start) as unknown as BookingRow[];
  const update = db.prepare('UPDATE bookings SET dentist_id = ?, updated_at = ?, updated_by = ? WHERE id = ?');
  let assigned = 0;
  for (const row of rows) {
    const date = utcIsoToManilaLocal(row.start_at).slice(0, 10);
    const day = manilaDayRangeUtc(date);
    const range = rangeOf(row.start_at, Number(row.duration_minutes));
    // Re-read each time so earlier assignments in this loop count.
    const bookings = activeBookings(db, day.start, day.end, row.id);
    const free = freeDentists(
      // Chairs are already in use by these bookings; only check that a dentist is free.
      { date, dentists: env.dentists, closures: env.closures, bookings, capacity: Number.MAX_SAFE_INTEGER },
      range,
    );
    const pick = chooseDentist(free, regularDentist(db, row.mobile), bookings, env.dentists.map((d) => d.id));
    if (pick === null) continue;
    update.run(pick, now.toISOString(), by, row.id);
    assigned++;
  }
  return { assigned, left: rows.length - assigned };
}

/** Other bookings for the same mobile, newest first. */
export function patientHistory(db: Db, mobile: string, excludeId: number): Booking[] {
  const rows = db
    .prepare('SELECT * FROM bookings WHERE mobile = ? AND id != ? ORDER BY start_at DESC LIMIT 50')
    .all(mobile, excludeId) as unknown as BookingRow[];
  return rows.map(toBooking);
}

/** The most recent name used with a mobile number, for autofilling staff forms. */
export function lookupPatient(
  db: Db,
  mobile: string,
): { fullName: string; visits: number; noShows: number; lastVisit: string | null; regularDentistId: number | null } | null {
  const latest = db
    .prepare('SELECT full_name FROM bookings WHERE mobile = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(mobile) as { full_name: string } | undefined;
  if (!latest) return null;
  const stats = db
    .prepare(
      `SELECT SUM(status = 'completed') AS visits, SUM(status = 'no_show') AS no_shows,
              MAX(CASE WHEN status = 'completed' THEN start_at END) AS last_visit
       FROM bookings WHERE mobile = ?`,
    )
    .get(mobile) as { visits: number | null; no_shows: number | null; last_visit: string | null };
  return {
    fullName: latest.full_name,
    visits: Number(stats.visits ?? 0),
    noShows: Number(stats.no_shows ?? 0),
    lastVisit: stats.last_visit,
    regularDentistId: regularDentist(db, mobile),
  };
}

function toEntry(r: BookingRow): ScheduleEntry {
  return {
    id: r.id,
    fullName: r.full_name,
    service: r.service as Service,
    status: r.status as BookingStatus,
    startAt: r.start_at,
    durationMinutes: Number(r.duration_minutes),
    dentistId: r.dentist_id,
  };
}

/** Active bookings on a Manila day, for the staff schedule view. */
export function scheduleForDay(db: Db, date: string): ScheduleEntry[] {
  const day = manilaDayRangeUtc(date);
  const rows = db
    .prepare(`SELECT * FROM bookings WHERE ${ACTIVE} AND start_at >= ? AND start_at < ? ORDER BY start_at ASC`)
    .all(day.start, day.end) as unknown as BookingRow[];
  return rows.map(toEntry);
}

/** Every non-cancelled booking between two Manila dates (inclusive), for the calendar. */
export function calendarEntries(db: Db, from: string, to: string): ScheduleEntry[] {
  const rows = db
    .prepare("SELECT * FROM bookings WHERE status != 'cancelled' AND start_at >= ? AND start_at < ? ORDER BY start_at ASC")
    .all(manilaDayRangeUtc(from).start, manilaDayRangeUtc(to).end) as unknown as BookingRow[];
  return rows.map(toEntry);
}

export function saveBooking(
  db: Db,
  id: number,
  changes: {
    status: BookingStatus;
    startAt: string;
    durationMinutes: number;
    staffNotes: string;
    dentistId: number | null;
    dentistRequested: boolean;
  },
  updatedBy: string,
  now: Date,
): Booking {
  db.prepare(
    `UPDATE bookings SET status = :status, start_at = :startAt, duration_minutes = :durationMinutes,
       staff_notes = :staffNotes, dentist_id = :dentistId, dentist_requested = :dentistRequested,
       updated_at = :ts, updated_by = :by WHERE id = :id`,
  ).run({ ...changes, dentistRequested: changes.dentistRequested ? 1 : 0, ts: now.toISOString(), by: updatedBy, id });
  return getBooking(db, id)!;
}

/** saveBooking with everything not given kept as it is. */
export function updateBooking(
  db: Db,
  b: Booking,
  changes: Partial<Pick<Booking, 'status' | 'startAt' | 'durationMinutes' | 'staffNotes' | 'dentistId' | 'dentistRequested'>>,
  updatedBy: string,
  now: Date,
): Booking {
  return saveBooking(
    db,
    b.id,
    {
      status: changes.status ?? b.status,
      startAt: changes.startAt ?? b.startAt,
      durationMinutes: changes.durationMinutes ?? b.durationMinutes,
      staffNotes: changes.staffNotes ?? b.staffNotes,
      dentistId: changes.dentistId !== undefined ? changes.dentistId : b.dentistId,
      dentistRequested: changes.dentistRequested ?? b.dentistRequested,
    },
    updatedBy,
    now,
  );
}

// ---- Patient self-service ----

export function findForPatient(db: Db, reference: string, mobile: string): Booking | null {
  const row = db.prepare('SELECT * FROM bookings WHERE reference = ? AND mobile = ?').get(reference, mobile) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

/** Patients may change or cancel online until the day before the appointment. */
export function patientCanChange(b: Booking, now: Date): boolean {
  return (b.status === 'pending' || b.status === 'confirmed') && utcIsoToManilaLocal(b.startAt).slice(0, 10) > manilaToday(now);
}

// ---- Reports ----

export function buildReport(db: Db, from: string, to: string, dentists: Dentist[]): ReportsResponse {
  const range = { from: manilaDayRangeUtc(from).start, to: manilaDayRangeUtc(to).end };
  const count = (sql: string) => Number((db.prepare(sql).get(range) as { n: number }).n);

  const created = (source: string) =>
    count(`SELECT COUNT(*) AS n FROM bookings WHERE source = '${source}' AND created_at >= :from AND created_at < :to`);
  const byStatus = (status: string) =>
    count(`SELECT COUNT(*) AS n FROM bookings WHERE status = '${status}' AND start_at >= :from AND start_at < :to`);

  const appts = db
    .prepare(
      `SELECT b.service, b.start_at, b.dentist_id,
         EXISTS (SELECT 1 FROM bookings p WHERE p.mobile = b.mobile AND p.id != b.id
                 AND p.status != 'cancelled' AND p.start_at < b.start_at) AS is_returning
       FROM bookings b WHERE b.status != 'cancelled' AND b.start_at >= :from AND b.start_at < :to`,
    )
    .all(range) as Array<{ service: string; start_at: string; dentist_id: number | null; is_returning: number }>;

  const services = new Map<string, number>();
  const weekdays = new Map<number, number>();
  const hours = new Map<number, number>();
  const byDentistId = new Map<number | null, number>();
  let returning = 0;
  for (const a of appts) {
    services.set(a.service, (services.get(a.service) ?? 0) + 1);
    const local = utcIsoToManilaLocal(a.start_at);
    const wd = weekdayOf(local.slice(0, 10));
    weekdays.set(wd, (weekdays.get(wd) ?? 0) + 1);
    const h = Number(local.slice(11, 13));
    hours.set(h, (hours.get(h) ?? 0) + 1);
    byDentistId.set(a.dentist_id, (byDentistId.get(a.dentist_id) ?? 0) + 1);
    if (a.is_returning) returning++;
  }

  const nameOf = (id: number | null) => (id === null ? 'Unassigned' : (dentists.find((d) => d.id === id)?.name ?? 'Former dentist'));
  const dentistIds: Array<number | null> = [...dentists.filter((d) => d.active).map((d) => d.id)];
  for (const id of byDentistId.keys()) if (!dentistIds.includes(id)) dentistIds.push(id);

  return {
    from,
    to,
    totals: {
      requestsOnline: created('online'),
      addedByStaff: created('staff'),
      appointments: appts.length,
      completed: byStatus('completed'),
      noShows: byStatus('no_show'),
      cancelled: byStatus('cancelled'),
      newPatients: appts.length - returning,
      returningPatients: returning,
    },
    byService: SERVICES.map((s) => ({ service: s, count: services.get(s) ?? 0 })).sort((a, b) => b.count - a.count),
    byDentist: dentistIds.map((id) => ({ dentistId: id, name: nameOf(id), count: byDentistId.get(id) ?? 0 })),
    // Clinic days in week order (Mon–Thu, Sat), plus any other day that has bookings (e.g. staff exceptions).
    byWeekday: [1, 2, 3, 4, 5, 6, 0]
      .filter((wd) => isClinicDay(addDays('2026-01-04', wd)) || weekdays.has(wd))
      .map((wd) => ({ weekday: wd, count: weekdays.get(wd) ?? 0 })),
    byHour: Array.from({ length: 8 }, (_, i) => 9 + i)
      .concat([...hours.keys()].filter((h) => h < 9 || h > 16))
      .sort((a, b) => a - b)
      .map((h) => ({ hour: h, count: hours.get(h) ?? 0 })),
  };
}
