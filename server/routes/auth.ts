import express from 'express';
import { z } from 'zod';
import { changePasswordSchema, type StaffUser } from '../../shared/booking.ts';
import { logAudit } from '../audit.ts';
import {
  authenticate,
  checkPassword,
  createSession,
  deleteOtherSessions,
  deleteSession,
  requireStaff,
  SESSION_COOKIE,
  updateAccount,
  userForSession,
} from '../auth.ts';
import { parseBody, type Ctx } from '../context.ts';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email.').max(200),
  password: z.string().min(1, 'Enter your password.').max(200),
});

export function authRoutes({ db, now, production, limit }: Ctx) {
  const r = express.Router();

  r.post(
    '/login',
    limit({ windowMs: 15 * 60_000, max: 10, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }),
    async (req, res) => {
      const parsed = loginSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Please fill in both fields.' });
        return;
      }
      const user = await authenticate(db, parsed.data.email, parsed.data.password, now());
      if (!user) {
        res.status(401).json({ error: 'That email and password don’t match an active account.' });
        return;
      }
      const { token, expires } = createSession(db, user.id, now());
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: production, expires, path: '/' });
      res.json({ user });
    },
  );

  r.post('/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  r.get('/me', (req, res) => {
    const user = userForSession(db, req.cookies?.[SESSION_COOKIE], now());
    if (!user) {
      res.status(401).json({ error: 'Not signed in.' });
      return;
    }
    res.json({ user });
  });

  r.post(
    '/password',
    requireStaff(db, now),
    limit({ windowMs: 15 * 60_000, max: 10, message: 'Too many attempts. Please wait and try again.' }),
    async (req, res) => {
      const data = parseBody(changePasswordSchema, req, res);
      if (!data) return;
      const staff = res.locals.staff as StaffUser;
      if (!(await checkPassword(db, staff.id, data.currentPassword))) {
        res.status(400).json({ error: 'Your current password is incorrect.', fields: { currentPassword: 'Incorrect password.' } });
        return;
      }
      await updateAccount(db, staff.id, { password: data.newPassword });
      // updateAccount signed out every session; start a fresh one here so this device stays signed in.
      const { token, expires } = createSession(db, staff.id, now());
      deleteOtherSessions(db, staff.id, token);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: production, expires, path: '/' });
      logAudit(db, { type: 'staff', user: staff }, 'user.password_changed', 'Changed their own password', now());
      res.status(204).end();
    },
  );

  return r;
}
