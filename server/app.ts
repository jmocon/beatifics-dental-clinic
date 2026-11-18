import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { makeLimiter, type Ctx } from './context.ts';
import type { Db } from './db.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { publicRoutes } from './routes/public.ts';

export interface AppOptions {
  db: Db;
  /** Injectable clock, for tests. */
  now?: () => Date;
  production?: boolean;
  /** Directory of the built React app to serve (production). */
  staticDir?: string;
  /** Disable rate limits (tests). */
  rateLimits?: boolean;
}

export function createApp({ db, now = () => new Date(), production = false, staticDir, rateLimits = true }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '20kb' }));
  app.use(cookieParser());

  const ctx: Ctx = { db, now, production, limit: makeLimiter(rateLimits) };
  app.use('/api', publicRoutes(ctx));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // ---------- Built React app (production) ----------

  if (staticDir && existsSync(staticDir)) {
    const indexHtml = resolve(staticDir, 'index.html');
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(indexHtml);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid request.' });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request is too large.' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}
