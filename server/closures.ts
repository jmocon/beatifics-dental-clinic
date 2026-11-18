import { addDays } from '../shared/dates.ts';
import type { Closure, ClosureRepeat } from '../shared/schedule.ts';
import type { Db } from './db.ts';

interface ClosureRow {
  id: number;
  start_date: string;
  end_date: string | null;
  repeat: string;
  start_time: string | null;
  end_time: string | null;
  reason: string;
  dentist_id: number | null;
}

const toClosure = (r: ClosureRow): Closure => ({
  id: r.id,
  startDate: r.start_date,
  endDate: r.end_date,
  repeat: r.repeat as ClosureRepeat,
  startTime: r.start_time,
  endTime: r.end_time,
  reason: r.reason,
  dentistId: r.dentist_id,
});

/** Closures that can still affect dates on or after `fromDate`. */
export function activeClosures(db: Db, fromDate: string): Closure[] {
  const rows = db
    .prepare(
      `SELECT * FROM closures
       WHERE (repeat = 'none' AND COALESCE(end_date, start_date) >= :from)
          OR (repeat != 'none' AND (end_date IS NULL OR end_date >= :from))
       ORDER BY start_date, start_time`,
    )
    .all({ from: fromDate }) as unknown as ClosureRow[];
  return rows.map(toClosure);
}

export function getClosure(db: Db, id: number): Closure | null {
  const row = db.prepare('SELECT * FROM closures WHERE id = ?').get(id) as ClosureRow | undefined;
  return row ? toClosure(row) : null;
}

export function createClosure(db: Db, c: Omit<Closure, 'id'>, createdBy: string, now: Date): Closure {
  const result = db
    .prepare(
      `INSERT INTO closures (start_date, end_date, repeat, start_time, end_time, reason, dentist_id, created_at, created_by)
       VALUES (:startDate, :endDate, :repeat, :startTime, :endTime, :reason, :dentistId, :at, :by)`,
    )
    .run({ ...c, at: now.toISOString(), by: createdBy });
  return getClosure(db, Number(result.lastInsertRowid))!;
}

export function deleteClosure(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM closures WHERE id = ?').run(id).changes > 0;
}

/** Dates (inclusive) a closure touches within a window; used to find affected bookings. */
export function closureWindow(c: Pick<Closure, 'startDate' | 'endDate' | 'repeat'>, horizonDays = 120): { from: string; to: string } {
  if (c.repeat === 'none') return { from: c.startDate, to: c.endDate ?? c.startDate };
  return { from: c.startDate, to: c.endDate ?? addDays(c.startDate, horizonDays) };
}
