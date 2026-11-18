import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { zodFieldErrors } from '../shared/booking.ts';
import { formatDateTime, manilaToday } from '../shared/dates.ts';
import { formatDuration } from '../shared/schedule.ts';
import type { SlotEnv } from './bookings.ts';
import { activeClosures } from './closures.ts';
import type { Db } from './db.ts';
import { activeDentists, getDentist } from './dentists.ts';
import { rateLimit } from './rateLimit.ts';
import { getSettings } from './settings.ts';

export interface Ctx {
  db: Db;
  now: () => Date;
  production: boolean;
  /** Rate limiter, or a pass-through when limits are disabled (tests). */
  limit: (opts: Parameters<typeof rateLimit>[0]) => RequestHandler;
}

export function makeLimiter(enabled: boolean): Ctx['limit'] {
  return (opts) => (enabled ? rateLimit(opts) : (_req: Request, _res: Response, next: NextFunction) => next());
}

/** Parse a body with Zod, or send a 400 with field errors and return null. */
export function parseBody<T extends z.ZodType>(schema: T, req: Request, res: Response): z.output<T> | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Please check the highlighted fields.', fields: zodFieldErrors(parsed.error) });
    return null;
  }
  return parsed.data;
}

export function idParam(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 'Wed, 7 Oct, 9:00 AM (1 hour)' for activity log summaries, plus ' with Dr X' when known. */
export function whenText(startAt: string, durationMinutes: number, dentistName?: string | null): string {
  return `${formatDateTime(startAt)} (${formatDuration(durationMinutes)})${dentistName ? ` with ${dentistName}` : ''}`;
}

/** Everything that decides whether a time can be booked right now. */
export function slotEnv(db: Db, now: Date): SlotEnv {
  return { settings: getSettings(db), closures: activeClosures(db, manilaToday(now)), dentists: activeDentists(db) };
}

export function dentistName(db: Db, id: number | null): string | null {
  return id === null ? null : (getDentist(db, id)?.name ?? null);
}
