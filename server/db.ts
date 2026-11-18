import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Each entry upgrades the schema by one version. Append only; never edit a shipped migration.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE bookings (
    id              INTEGER PRIMARY KEY,
    reference       TEXT NOT NULL UNIQUE,
    full_name       TEXT NOT NULL,
    mobile          TEXT NOT NULL,
    service         TEXT NOT NULL,
    preferred_date  TEXT NOT NULL,
    time_preference TEXT NOT NULL DEFAULT 'any',
    notes           TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','completed','no_show','cancelled')),
    confirmed_at    TEXT,
    staff_notes     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    updated_by      TEXT
  );

  CREATE INDEX bookings_status_idx ON bookings(status);
  CREATE INDEX bookings_preferred_date_idx ON bookings(preferred_date);
  CREATE INDEX bookings_confirmed_at_idx ON bookings(confirmed_at);
  CREATE INDEX bookings_mobile_idx ON bookings(mobile);
  `,
  // v2: patients pick an exact time slot; every booking has a start time and a length.
  `
  ALTER TABLE bookings ADD COLUMN start_at TEXT;
  ALTER TABLE bookings ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 60;
  UPDATE bookings SET start_at = COALESCE(
    confirmed_at,
    strftime('%Y-%m-%dT%H:%M:%fZ',
      preferred_date || CASE time_preference WHEN 'afternoon' THEN ' 13:00' ELSE ' 09:00' END, '-8 hours')
  );
  DROP INDEX bookings_confirmed_at_idx;
  DROP INDEX bookings_preferred_date_idx;
  ALTER TABLE bookings DROP COLUMN confirmed_at;
  ALTER TABLE bookings DROP COLUMN preferred_date;
  ALTER TABLE bookings DROP COLUMN time_preference;
  CREATE INDEX bookings_start_at_idx ON bookings(start_at);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v3: staff roles, activity log, closures/blocked times, where a booking came from.
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'staff'));
  ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN last_login_at TEXT;

  ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'staff'));

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    at         TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('patient', 'staff')),
    actor_id   INTEGER,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    summary    TEXT NOT NULL
  );
  CREATE INDEX audit_log_at_idx ON audit_log(at);
  CREATE INDEX audit_log_booking_idx ON audit_log(booking_id);

  CREATE TABLE closures (
    id         INTEGER PRIMARY KEY,
    start_date TEXT NOT NULL,
    end_date   TEXT,
    repeat     TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly')),
    start_time TEXT,
    end_time   TEXT,
    reason     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT
  );
  `,
  // v4: dentists. Bookings and closures can belong to a dentist; staff accounts can be linked to one.
  `
  CREATE TABLE dentists (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL,
    working_days TEXT NOT NULL DEFAULT '[1,2,3,4,6]',
    active       INTEGER NOT NULL DEFAULT 1,
    user_id      INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );

  ALTER TABLE bookings ADD COLUMN dentist_id INTEGER REFERENCES dentists(id) ON DELETE SET NULL;
  ALTER TABLE bookings ADD COLUMN dentist_requested INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX bookings_dentist_idx ON bookings(dentist_id);

  ALTER TABLE closures ADD COLUMN dentist_id INTEGER REFERENCES dentists(id) ON DELETE CASCADE;
  `,
];

export function migrate(db: Db): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function defaultDbPath(): string {
  return process.env.DATABASE_PATH ?? './data/beatifics.db';
}
