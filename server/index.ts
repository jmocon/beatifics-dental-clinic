import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { defaultDbPath, openDb } from './db.ts';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3001);
const db = openDb(defaultDbPath());

const app = createApp({ db, production, staticDir: resolve('dist') });

app.listen(port, () => {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  console.log(`Beatifics API listening on http://localhost:${port}`);
  if (Number(count) === 0) {
    console.log('No staff accounts yet. Create one with:  npm run create-admin -- <email> "<name>" <password>');
  }
});
