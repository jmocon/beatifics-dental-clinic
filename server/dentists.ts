import { DENTIST_COLORS, type Dentist, type PublicDentist } from '../shared/dentists.ts';
import type { Db } from './db.ts';

interface DentistRow {
  id: number;
  name: string;
  color: string;
  working_days: string;
  active: number;
  user_id: number | null;
}

function parseDays(raw: string): number[] {
  try {
    const days = JSON.parse(raw);
    return Array.isArray(days) ? days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  } catch {
    return [];
  }
}

const toDentist = (r: DentistRow): Dentist => ({
  id: r.id,
  name: r.name,
  color: r.color,
  workingDays: parseDays(r.working_days),
  active: r.active === 1,
  userId: r.user_id,
});

/** All dentists (active first, in the order they were added). */
export function listDentists(db: Db): Dentist[] {
  const rows = db.prepare('SELECT * FROM dentists ORDER BY active DESC, sort_order, id').all() as unknown as DentistRow[];
  return rows.map(toDentist);
}

export const activeDentists = (db: Db) => listDentists(db).filter((d) => d.active);

export function publicDentists(db: Db): PublicDentist[] {
  return activeDentists(db).map((d) => ({ id: d.id, name: d.name, workingDays: d.workingDays }));
}

export function getDentist(db: Db, id: number): Dentist | null {
  const row = db.prepare('SELECT * FROM dentists WHERE id = ?').get(id) as DentistRow | undefined;
  return row ? toDentist(row) : null;
}

export function dentistForUser(db: Db, userId: number): number | null {
  const row = db.prepare('SELECT id FROM dentists WHERE user_id = ? AND active = 1').get(userId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** A user can be linked to at most one dentist. */
export function userLinkedElsewhere(db: Db, userId: number, dentistId: number | null): boolean {
  const row = db.prepare('SELECT id FROM dentists WHERE user_id = ?').get(userId) as { id: number } | undefined;
  return !!row && row.id !== dentistId;
}

export function createDentist(db: Db, d: { name: string; workingDays: number[]; userId: number | null }, now: Date): Dentist {
  // Colour follows the dentist: take the next palette slot no current dentist uses.
  const used = new Set(listDentists(db).map((x) => x.color));
  const color = DENTIST_COLORS.find((c) => !used.has(c)) ?? DENTIST_COLORS[listDentists(db).length % DENTIST_COLORS.length];
  const order = Number((db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dentists').get() as { n: number }).n);
  const result = db
    .prepare('INSERT INTO dentists (name, color, working_days, user_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.name, color, JSON.stringify(d.workingDays), d.userId, order, now.toISOString());
  return getDentist(db, Number(result.lastInsertRowid))!;
}

export function updateDentist(
  db: Db,
  id: number,
  changes: { name?: string; workingDays?: number[]; userId?: number | null; active?: boolean; color?: string },
): Dentist {
  if (changes.name !== undefined) db.prepare('UPDATE dentists SET name = ? WHERE id = ?').run(changes.name, id);
  if (changes.workingDays !== undefined) db.prepare('UPDATE dentists SET working_days = ? WHERE id = ?').run(JSON.stringify(changes.workingDays), id);
  if (changes.userId !== undefined) db.prepare('UPDATE dentists SET user_id = ? WHERE id = ?').run(changes.userId, id);
  if (changes.active !== undefined) db.prepare('UPDATE dentists SET active = ? WHERE id = ?').run(changes.active ? 1 : 0, id);
  if (changes.color !== undefined) db.prepare('UPDATE dentists SET color = ? WHERE id = ?').run(changes.color, id);
  return getDentist(db, id)!;
}
