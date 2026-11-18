import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { createUser } from './auth.ts';
import { migrate, MIGRATIONS, openDb, type Db } from './db.ts';

let now = new Date('2026-10-06T02:00:00Z'); // Tue 6 Oct, 10 AM Manila
let db: Db;
let app: ReturnType<typeof createApp>;

const booking = {
  fullName: 'Maria Santos',
  mobile: '0917 123 4567',
  service: 'Check-ups & Cleaning',
  preferredDate: '2026-10-07', // Wednesday
  preferredTime: '09:00',
  notes: 'Sensitive upper right tooth',
  consent: true,
};

let mobileCounter = 0;
/** A different valid mobile each call, so requests aren't treated as duplicates. */
const nextMobile = () => `0917000${String(1000 + mobileCounter++).slice(-4)}`;

async function staffAgent() {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: 'staff@clinic.test', password: 'correct-horse-battery' });
  expect(res.status).toBe(200);
  return agent;
}

async function createRequest(overrides: Partial<typeof booking> = {}) {
  const res = await request(app).post('/api/bookings').send({ ...booking, ...overrides });
  expect(res.status).toBe(201);
  const row = db.prepare('SELECT id FROM bookings WHERE reference = ?').get(res.body.reference) as { id: number };
  return row.id;
}

beforeEach(async () => {
  now = new Date('2026-10-06T02:00:00Z');
  db = openDb(':memory:');
  await createUser(db, 'staff@clinic.test', 'Rose', 'correct-horse-battery');
  app = createApp({ db, now: () => now, rateLimits: false });
});

describe('POST /api/bookings (public)', () => {
  it('stores a valid request as pending with the chosen slot and default length', async () => {
    const res = await request(app).post('/api/bookings').send(booking);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ startAt: '2026-10-07T01:00:00.000Z', durationMinutes: 60, duplicate: false });
    expect(res.body.reference).toMatch(/^BD-[A-Z2-9]{5}$/);
    const row = db.prepare('SELECT * FROM bookings').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      full_name: 'Maria Santos',
      mobile: '09171234567',
      status: 'pending',
      start_at: '2026-10-07T01:00:00.000Z',
      duration_minutes: 60,
    });
  });

  it('returns field errors for invalid input', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .send({ ...booking, mobile: '12345', preferredDate: '2026-10-09', preferredTime: '', consent: false });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(['consent', 'mobile', 'preferredDate', 'preferredTime']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).toEqual({ n: 0 });
  });

  it('rejects times that are not real slots', async () => {
    for (const t of ['08:00', '09:15', '16:30', '17:00']) {
      const res = await request(app).post('/api/bookings').send({ ...booking, preferredTime: t, mobile: nextMobile() });
      expect(res.status, t).toBe(409);
    }
  });

  it('does not create duplicates for the same mobile on the same day', async () => {
    const a = await request(app).post('/api/bookings').send(booking);
    const b = await request(app).post('/api/bookings').send({ ...booking, mobile: '+63 917 123 4567', preferredTime: '14:00' });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ reference: a.body.reference, duplicate: true, startAt: '2026-10-07T01:00:00.000Z' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).toEqual({ n: 1 });
  });

  it('stores HTML as plain text (rendered escaped by React)', async () => {
    await createRequest({ fullName: '<script>alert(1)</script>', notes: '<img src=x onerror=alert(1)>' });
    const row = db.prepare('SELECT full_name, notes FROM bookings').get();
    expect(row).toEqual({ full_name: '<script>alert(1)</script>', notes: '<img src=x onerror=alert(1)>' });
  });

  it('silently drops honeypot submissions', async () => {
    const res = await request(app).post('/api/bookings').send({ ...booking, website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).toEqual({ n: 0 });
  });

  it('rejects malformed JSON cleanly', async () => {
    const res = await request(app).post('/api/bookings').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });

  it('rate-limits repeated requests', async () => {
    const limited = createApp({ db, now: () => now });
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await request(limited).post('/api/bookings').send({})).status;
    expect(last).toBe(429);
  });
});

describe('time slots and capacity', () => {
  it('lists free times for each bookable clinic day', async () => {
    const res = await request(app).get('/api/availability');
    expect(res.status).toBe(200);
    expect(res.body.durationMinutes).toBe(60);
    const days = Object.keys(res.body.days);
    expect(days[0]).toBe('2026-10-07'); // tomorrow
    expect(days).not.toContain('2026-10-09'); // Friday
    expect(days).not.toContain('2026-10-11'); // Sunday
    expect(res.body.days['2026-10-07']).toHaveLength(15);
  });

  it('fills a time once capacity (default 2) is reached, and frees it on cancel', async () => {
    await createRequest({ mobile: nextMobile() });
    const second = await createRequest({ mobile: nextMobile() });

    const third = await request(app).post('/api/bookings').send({ ...booking, mobile: nextMobile() });
    expect(third.status).toBe(409);
    expect(third.body.fields.preferredTime).toBeTruthy();

    let slots: string[] = (await request(app).get('/api/availability')).body.days['2026-10-07'];
    expect(slots).not.toContain('09:00');
    expect(slots).not.toContain('09:30'); // overlaps both 9–10 bookings
    expect(slots).toContain('10:00'); // free: the 9–10 bookings end as 10:00 starts

    const agent = await staffAgent();
    await agent.patch(`/api/admin/bookings/${second}`).send({ status: 'cancelled' });
    slots = (await request(app).get('/api/availability')).body.days['2026-10-07'];
    expect(slots).toContain('09:00');
  });

  it('respects a longer length set by staff when offering times', async () => {
    const id = await createRequest({ mobile: nextMobile() });
    await createRequest({ mobile: nextMobile(), preferredTime: '10:00' });
    const agent = await staffAgent();
    // Stretch the 9:00 booking to 2 hours: it now overlaps the 10:00 one.
    await agent.patch(`/api/admin/bookings/${id}`).send({ durationMinutes: 120 });
    const slots: string[] = (await request(app).get('/api/availability')).body.days['2026-10-07'];
    expect(slots).not.toContain('10:00');
    expect(slots).toContain('09:00'); // 9–10 only has one patient (the 9:00 one)
  });

  it('marks a day as full when no time fits', async () => {
    const agent = await staffAgent();
    await agent.put('/api/admin/settings').send({ appointmentMinutes: 240, capacity: 1 });
    await createRequest({ mobile: nextMobile(), preferredTime: '09:00' });
    await createRequest({ mobile: nextMobile(), preferredTime: '13:00' });
    const slots: string[] = (await request(app).get('/api/availability')).body.days['2026-10-07'];
    expect(slots).toEqual([]);
  });
});

describe('admin access control', () => {
  it('blocks every admin endpoint without a session', async () => {
    const id = await createRequest();
    expect((await request(app).get('/api/admin/bookings')).status).toBe(401);
    expect((await request(app).get(`/api/admin/bookings/${id}`)).status).toBe(401);
    expect((await request(app).patch(`/api/admin/bookings/${id}`).send({ status: 'cancelled' })).status).toBe(401);
    expect((await request(app).get('/api/admin/schedule?date=2026-10-07')).status).toBe(401);
    expect((await request(app).get('/api/admin/settings')).status).toBe(401);
    expect((await request(app).put('/api/admin/settings').send({ appointmentMinutes: 15, capacity: 9 })).status).toBe(401);
    expect((await request(app).get('/api/admin/bookings').set('Cookie', 'bd_session=forged')).status).toBe(401);
  });

  it('rejects wrong passwords and unknown emails with the same message', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'staff@clinic.test', password: 'wrong' });
    const b = await request(app).post('/api/auth/login').send({ email: 'nobody@clinic.test', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('sets an httpOnly session cookie and ends it on logout', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'STAFF@clinic.test', password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/bd_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const agent = await staffAgent();
    expect((await agent.get('/api/auth/me')).body.user).toMatchObject({ name: 'Rose' });
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/admin/bookings')).status).toBe(401);
  });

  it('expires sessions after 7 days', async () => {
    const agent = await staffAgent();
    now = new Date(now.getTime() + 8 * 86_400_000);
    expect((await agent.get('/api/admin/bookings')).status).toBe(401);
  });
});

describe('admin bookings', () => {
  it('lists pending requests under "Needs action" in time order, with counts', async () => {
    await createRequest({ preferredTime: '11:00' });
    await createRequest({ fullName: 'Jose Reyes', mobile: '09281112233', preferredTime: '09:30' });
    const agent = await staffAgent();
    const res = await agent.get('/api/admin/bookings?view=action');
    expect(res.status).toBe(200);
    expect(res.body.bookings.map((b: { fullName: string }) => b.fullName)).toEqual(['Jose Reyes', 'Maria Santos']);
    expect(res.body.counts).toEqual({ action: 2, today: 0, upcoming: 0, all: 2 });
  });

  it('searches by name, mobile in any format, and reference', async () => {
    await createRequest();
    await createRequest({ fullName: 'Jose Reyes', mobile: '09281112233' });
    const agent = await staffAgent();
    const names = async (q: string) =>
      (await agent.get(`/api/admin/bookings?view=all&q=${encodeURIComponent(q)}`)).body.bookings.map((b: { fullName: string }) => b.fullName);
    expect(await names('maria')).toEqual(['Maria Santos']);
    expect(await names('+63 928 111')).toEqual(['Jose Reyes']);
    expect(await names('0917 123')).toEqual(['Maria Santos']);
    expect(await names('%')).toEqual([]);
  });

  it('confirms the requested time, then shows it under Upcoming and Today', async () => {
    const id = await createRequest();
    const agent = await staffAgent();

    const ok = await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'confirmed' });
    expect(ok.status).toBe(200);
    expect(ok.body.booking).toMatchObject({ status: 'confirmed', startAt: '2026-10-07T01:00:00.000Z', updatedBy: 'Rose' });

    let counts = (await agent.get('/api/admin/bookings')).body.counts;
    expect(counts).toMatchObject({ action: 0, upcoming: 1, today: 0 });

    now = new Date('2026-10-07T00:30:00Z'); // 8:30 AM Manila on the appointment day
    counts = (await agent.get('/api/admin/bookings?view=today')).body.counts;
    expect(counts.today).toBe(1);
  });

  it('lets staff change time and length while confirming or later', async () => {
    const id = await createRequest();
    const agent = await staffAgent();
    const a = await agent
      .patch(`/api/admin/bookings/${id}`)
      .send({ status: 'confirmed', startAt: '2026-10-07T09:30', durationMinutes: 90 });
    expect(a.body.booking).toMatchObject({ status: 'confirmed', startAt: '2026-10-07T01:30:00.000Z', durationMinutes: 90 });

    const b = await agent.patch(`/api/admin/bookings/${id}`).send({ startAt: '2026-10-08T14:00' });
    expect(b.body.booking).toMatchObject({ startAt: '2026-10-08T06:00:00.000Z', durationMinutes: 90 });
  });

  it('allows staff to overbook on purpose', async () => {
    await createRequest({ mobile: nextMobile() });
    await createRequest({ mobile: nextMobile() });
    const id = await createRequest({ mobile: nextMobile(), preferredTime: '13:00' });
    const agent = await staffAgent();
    const res = await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'confirmed', startAt: '2026-10-07T09:00' });
    expect(res.status).toBe(200);
  });

  it('validates time changes', async () => {
    const id = await createRequest();
    const agent = await staffAgent();
    expect((await agent.patch(`/api/admin/bookings/${id}`).send({ durationMinutes: 50 })).status).toBe(400);
    expect((await agent.patch(`/api/admin/bookings/${id}`).send({ durationMinutes: 600 })).status).toBe(400);
    expect((await agent.patch(`/api/admin/bookings/${id}`).send({ startAt: '2026-10-07 09:00' })).status).toBe(400);

    await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'confirmed' });
    await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'completed' });
    expect((await agent.patch(`/api/admin/bookings/${id}`).send({ startAt: '2026-10-08T09:00' })).status).toBe(400);
  });

  it('blocks invalid status changes', async () => {
    const id = await createRequest();
    const agent = await staffAgent();
    expect((await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'completed' })).status).toBe(409);
    expect((await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'archived' })).status).toBe(400);
    expect((await agent.patch(`/api/admin/bookings/${id}`).send({})).status).toBe(400);

    await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'confirmed' });
    await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'completed' });
    const res = await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'pending' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/completed/);
  });

  it('reopens a cancelled request', async () => {
    const id = await createRequest();
    const agent = await staffAgent();
    await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'cancelled' });
    const res = await agent.patch(`/api/admin/bookings/${id}`).send({ status: 'pending' });
    expect(res.body.booking).toMatchObject({ status: 'pending', startAt: '2026-10-07T01:00:00.000Z' });
  });

  it('saves staff notes without changing status', async () => {
    const id = await createRequest();
    const agent = await staffAgent();
    const res = await agent.patch(`/api/admin/bookings/${id}`).send({ staffNotes: 'Called, no answer.' });
    expect(res.body.booking).toMatchObject({ status: 'pending', staffNotes: 'Called, no answer.' });
  });

  it('returns a day schedule of active bookings only', async () => {
    await createRequest({ mobile: nextMobile(), preferredTime: '10:00' });
    const cancelled = await createRequest({ mobile: nextMobile(), preferredTime: '11:00' });
    await createRequest({ mobile: nextMobile(), preferredDate: '2026-10-08' });
    const agent = await staffAgent();
    await agent.patch(`/api/admin/bookings/${cancelled}`).send({ status: 'cancelled' });

    const res = await agent.get('/api/admin/schedule?date=2026-10-07');
    expect(res.body.capacity).toBe(2);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ startAt: '2026-10-07T02:00:00.000Z', durationMinutes: 60 });
    expect(res.body.entries[0].mobile).toBeUndefined();
    expect((await agent.get('/api/admin/schedule?date=nope')).status).toBe(400);
  });

  it('returns 404 for unknown bookings', async () => {
    const agent = await staffAgent();
    expect((await agent.get('/api/admin/bookings/999')).status).toBe(404);
    expect((await agent.get('/api/admin/bookings/abc')).status).toBe(404);
    expect((await agent.patch('/api/admin/bookings/999').send({ staffNotes: 'x' })).status).toBe(404);
  });
});

describe('staff-added appointments', () => {
  const walkIn = {
    fullName: 'Lola Remedios',
    mobile: '0918 222 3333',
    service: 'Consultation / check-up',
    startAt: '2026-10-06T15:00',
    durationMinutes: 45,
  };

  it('requires staff login', async () => {
    expect((await request(app).post('/api/admin/bookings').send(walkIn)).status).toBe(401);
  });

  it('adds a confirmed appointment by default, recorded as created by staff', async () => {
    const agent = await staffAgent();
    const res = await agent.post('/api/admin/bookings').send({ ...walkIn, staffNotes: 'Booked by phone' });
    expect(res.status).toBe(201);
    expect(res.body.booking).toMatchObject({
      fullName: 'Lola Remedios',
      mobile: '09182223333',
      status: 'confirmed',
      startAt: '2026-10-06T07:00:00.000Z',
      durationMinutes: 45,
      staffNotes: 'Booked by phone',
      updatedBy: 'Rose',
    });
    // Same-day bookings are fine for staff, and it shows in Today.
    expect((await agent.get('/api/admin/bookings?view=today')).body.counts.today).toBe(1);
  });

  it('can add it as pending instead', async () => {
    const agent = await staffAgent();
    const res = await agent.post('/api/admin/bookings').send({ ...walkIn, status: 'pending' });
    expect(res.body.booking.status).toBe('pending');
  });

  it('may overbook, and the time then disappears from online availability', async () => {
    const agent = await staffAgent();
    const at9 = { ...walkIn, startAt: '2026-10-07T09:00', durationMinutes: 60 };
    for (let i = 0; i < 3; i++) expect((await agent.post('/api/admin/bookings').send(at9)).status).toBe(201);
    const slots: string[] = (await request(app).get('/api/availability')).body.days['2026-10-07'];
    expect(slots).not.toContain('09:00');
  });

  it('validates input with staff-friendly messages', async () => {
    const agent = await staffAgent();
    const res = await agent
      .post('/api/admin/bookings')
      .send({ ...walkIn, fullName: '', mobile: '123', startAt: 'tomorrow', durationMinutes: 7, status: 'completed' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(['durationMinutes', 'fullName', 'mobile', 'startAt', 'status']);
    expect(res.body.fields.fullName).toMatch(/patient’s full name/);
  });
});

describe('clinic settings', () => {
  it('starts with defaults and applies saved values to new requests', async () => {
    const agent = await staffAgent();
    expect((await agent.get('/api/admin/settings')).body.settings).toEqual({ appointmentMinutes: 60, capacity: 2, serviceMinutes: {} });

    const saved = await agent.put('/api/admin/settings').send({ appointmentMinutes: 90, capacity: 3 });
    expect(saved.body.settings).toEqual({ appointmentMinutes: 90, capacity: 3, serviceMinutes: {} });

    const res = await request(app).post('/api/bookings').send(booking);
    expect(res.body.durationMinutes).toBe(90);
    const avail = (await request(app).get('/api/availability')).body;
    expect(avail.durationMinutes).toBe(90);
    expect(avail.days['2026-10-08'].at(-1)).toBe('15:30');
  });

  it('rejects invalid settings', async () => {
    const agent = await staffAgent();
    for (const body of [{ appointmentMinutes: 50, capacity: 2 }, { appointmentMinutes: 60, capacity: 0 }, { capacity: 2 }]) {
      expect((await agent.put('/api/admin/settings').send(body)).status).toBe(400);
    }
  });
});

describe('database upgrade', () => {
  it('moves v1 bookings (preferred day / confirmed time) to start times', () => {
    const old = new DatabaseSync(':memory:');
    old.exec(MIGRATIONS[0]);
    old.exec('PRAGMA user_version = 1');
    const insert = old.prepare(
      `INSERT INTO bookings (reference, full_name, mobile, service, preferred_date, time_preference, status, confirmed_at, created_at, updated_at)
       VALUES (?, 'X', '09170000000', 'Check-ups & Cleaning', ?, ?, ?, ?, 't', 't')`,
    );
    insert.run('BD-AAAAA', '2026-10-07', 'afternoon', 'pending', null);
    insert.run('BD-BBBBB', '2026-10-08', 'any', 'confirmed', '2026-10-08T02:30:00.000Z');

    migrate(old);
    const rows = old.prepare('SELECT reference, start_at, duration_minutes FROM bookings ORDER BY reference').all();
    expect(rows).toEqual([
      { reference: 'BD-AAAAA', start_at: '2026-10-07T05:00:00.000Z', duration_minutes: 60 },
      { reference: 'BD-BBBBB', start_at: '2026-10-08T02:30:00.000Z', duration_minutes: 60 },
    ]);
  });
});
