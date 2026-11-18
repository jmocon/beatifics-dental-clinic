import type { AuditEntry, StaffUser } from '../shared/booking.ts';
import type { Db } from './db.ts';

export type Actor = { type: 'patient' } | { type: 'staff'; user: StaffUser };

interface AuditRow {
  id: number;
  at: string;
  actor_type: 'patient' | 'staff';
  actor: string;
  action: string;
  booking_id: number | null;
  summary: string;
}

const toEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  at: r.at,
  actorType: r.actor_type,
  actor: r.actor,
  action: r.action,
  bookingId: r.booking_id,
  summary: r.summary,
});

/** Record who did what. Every change to bookings, settings, closures and accounts goes through here. */
export function logAudit(db: Db, actor: Actor, action: string, summary: string, now: Date, bookingId: number | null = null): void {
  db.prepare(
    `INSERT INTO audit_log (at, actor_type, actor_id, actor, action, booking_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now.toISOString(),
    actor.type,
    actor.type === 'staff' ? actor.user.id : null,
    actor.type === 'staff' ? actor.user.name : 'Patient',
    action,
    bookingId,
    summary,
  );
}

export function auditForBooking(db: Db, bookingId: number): AuditEntry[] {
  const rows = db.prepare('SELECT * FROM audit_log WHERE booking_id = ? ORDER BY at DESC, id DESC').all(bookingId) as unknown as AuditRow[];
  return rows.map(toEntry);
}

export function recentAudit(db: Db, limit = 100): AuditEntry[] {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?').all(limit) as unknown as AuditRow[];
  return rows.map(toEntry);
}

/** Patient actions (new requests, cancellations, reschedules) after a moment, oldest first. */
export function patientEventsSince(db: Db, sinceIso: string, limit = 20): AuditEntry[] {
  const rows = db
    .prepare("SELECT * FROM audit_log WHERE actor_type = 'patient' AND at > ? ORDER BY at ASC, id ASC LIMIT ?")
    .all(sinceIso, limit) as unknown as AuditRow[];
  return rows.map(toEntry);
}
