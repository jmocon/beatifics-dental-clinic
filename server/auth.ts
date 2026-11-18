import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import type { Role, StaffAccount, StaffUser } from '../shared/booking.ts';
import type { Db } from './db.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'bd_session';
const SESSION_DAYS = 7;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// A fixed hash used to keep login timing similar when the email doesn't exist.
let dummyHash: Promise<string> | undefined;

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: number;
  password_hash: string;
  last_login_at: string | null;
  created_at: string;
  dentist_id: number | null;
}

/** Users plus the active dentist linked to them (if any). */
const USER_SELECT = `SELECT u.*, (SELECT d.id FROM dentists d WHERE d.user_id = u.id AND d.active = 1) AS dentist_id FROM users u`;

const toUser = (r: Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'dentist_id'>): StaffUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  dentistId: r.dentist_id ?? null,
});

const toAccount = (r: UserRow): StaffAccount => ({
  ...toUser(r),
  active: r.active === 1,
  lastLoginAt: r.last_login_at,
  createdAt: r.created_at,
});

/** Check a password. Deactivated accounts can't sign in. */
export async function authenticate(db: Db, email: string, password: string, now: Date): Promise<StaffUser | null> {
  const row = db.prepare(`${USER_SELECT} WHERE u.email = ?`).get(email.trim()) as UserRow | undefined;
  if (!row) {
    dummyHash ??= hashPassword('not-a-real-password');
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash)) || row.active !== 1) return null;
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return toUser(row);
}

export async function checkPassword(db: Db, userId: number, password: string): Promise<boolean> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
  return !!row && (await verifyPassword(password, row.password_hash));
}

export function emailTaken(db: Db, email: string): boolean {
  return !!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim());
}

export async function createUser(db: Db, email: string, name: string, password: string, role: Role = 'admin'): Promise<StaffUser> {
  const hash = await hashPassword(password);
  const result = db
    .prepare('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email.trim(), name.trim(), hash, role, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), email: email.trim(), name: name.trim(), role, dentistId: null };
}

export function listAccounts(db: Db): StaffAccount[] {
  const rows = db.prepare(`${USER_SELECT} ORDER BY u.active DESC, u.name COLLATE NOCASE`).all() as unknown as UserRow[];
  return rows.map(toAccount);
}

export function getAccount(db: Db, id: number): StaffAccount | null {
  const row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow | undefined;
  return row ? toAccount(row) : null;
}

export function countActiveAdmins(db: Db): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get() as { n: number }).n);
}

export async function updateAccount(
  db: Db,
  id: number,
  changes: { name?: string; role?: Role; active?: boolean; password?: string },
): Promise<StaffAccount> {
  if (changes.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(changes.name, id);
  if (changes.role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(changes.role, id);
  if (changes.active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(changes.active ? 1 : 0, id);
  if (changes.password !== undefined) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(changes.password), id);
  }
  // A new password or deactivation signs the person out everywhere.
  if (changes.password !== undefined || changes.active === false) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  return getAccount(db, id)!;
}

export async function setUserPassword(db: Db, email: string, password: string): Promise<boolean> {
  const hash = await hashPassword(password);
  const result = db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE email = ?').run(hash, email.trim());
  if (result.changes > 0) {
    db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(email.trim());
  }
  return result.changes > 0;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: Db, userId: number, now: Date): { token: string; expires: Date } {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    now.toISOString(),
    expires.toISOString(),
  );
  return { token, expires };
}

export function deleteSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Sign out a user's other devices (e.g. after changing their own password). */
export function deleteOtherSessions(db: Db, userId: number, keepToken: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, hashToken(keepToken));
}

export function userForSession(db: Db, token: string | undefined, now: Date): StaffUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role,
         (SELECT d.id FROM dentists d WHERE d.user_id = u.id AND d.active = 1) AS dentist_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    )
    .get(hashToken(token), now.toISOString()) as Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'dentist_id'> | undefined;
  return row ? toUser(row) : null;
}

/** Express middleware: 401 unless the request has a valid staff session. Sets `res.locals.staff`. */
export function requireStaff(db: Db, now: () => Date) {
  return (req: Request, res: Response, next: NextFunction) => {
    const staff = userForSession(db, req.cookies?.[SESSION_COOKIE], now());
    if (!staff) {
      res.status(401).json({ error: 'Please sign in to continue.' });
      return;
    }
    res.locals.staff = staff;
    next();
  };
}

/** Use after requireStaff: 403 unless the signed-in user is an admin. */
export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if ((res.locals.staff as StaffUser | undefined)?.role !== 'admin') {
    res.status(403).json({ error: 'Only an admin can do this. Ask the clinic admin for help.' });
    return;
  }
  next();
}
