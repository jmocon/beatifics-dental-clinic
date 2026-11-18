// Tests for: service lengths, closures, alerts, patient self-service, history, staff accounts, reports, calendar.
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
  notes: '',
  consent: true,
};
const PATIENT_ID = { reference: '', mobile: '0917 123 4567' };

let n = 0;
const nextMobile = () => `0917000${String(1000 + n++).slice(-4)}`;

async function login(email = 'staff@clinic.test', password = 'correct-horse-battery') {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return agent;
}

async function requestBooking(overrides: Partial<typeof booking> = {}) {
  const res = await request(app).post('/api/bookings').send({ ...booking, ...overrides });
  expect(res.status).toBe(201);
  const row = db.prepare('SELECT id FROM bookings WHERE reference = ?').get(res.body.reference) as { id: number };
  return { id: row.id, reference: res.body.reference as string };
}

const slotsOn = async (date: string, service = booking.service): Promise<string[]> =>
  (await request(app).get(`/api/availability?service=${encodeURIComponent(service)}`)).body.days[date];

beforeEach(async () => {
  now = new Date('2026-10-06T02:00:00Z');
  db = openDb(':memory:');
  await createUser(db, 'staff@clinic.test', 'Rose', 'correct-horse-battery', 'admin');
  await createUser(db, 'desk@clinic.test', 'Desk', 'correct-horse-battery', 'staff');
  app = createApp({ db, now: () => now, rateLimits: false });
});

describe('length per service', () => {
  it('uses the service length for availability and new requests', async () => {
    const admin = await login();
    await admin.put('/api/admin/settings').send({ appointmentMinutes: 60, capacity: 2, serviceMinutes: { 'Root Canal Treatment': 120 } });

    const rc = (await request(app).get('/api/availability?service=Root%20Canal%20Treatment')).body;
    expect(rc.durationMinutes).toBe(120);
    expect(rc.days['2026-10-07'].at(-1)).toBe('15:00');
    expect((await slotsOn('2026-10-07')).at(-1)).toBe('16:00');

    const res = await request(app).post('/api/bookings').send({ ...booking, service: 'Root Canal Treatment' });
    expect(res.body.durationMinutes).toBe(120);
  });

  it('rejects unknown services and bad lengths in settings', async () => {
    const admin = await login();
    expect((await admin.put('/api/admin/settings').send({ appointmentMinutes: 60, capacity: 2, serviceMinutes: { Whitening: 60 } })).status).toBe(400);
    expect(
      (await admin.put('/api/admin/settings').send({ appointmentMinutes: 60, capacity: 2, serviceMinutes: { 'Root Canal Treatment': 50 } })).status,
    ).toBe(400);
  });

  it('only lets admins change settings', async () => {
    const desk = await login('desk@clinic.test');
    expect((await desk.get('/api/admin/settings')).status).toBe(200);
    expect((await desk.put('/api/admin/settings').send({ appointmentMinutes: 30, capacity: 2 })).status).toBe(403);
  });
});

describe('closures and blocked times', () => {
  it('a whole-day closure removes the day and blocks requests; removing it restores them', async () => {
    const desk = await login('desk@clinic.test');
    const res = await desk.post('/api/admin/closures').send({ startDate: '2026-10-07', reason: 'Holiday' });
    expect(res.status).toBe(201);
    expect(await slotsOn('2026-10-07')).toEqual([]);
    expect((await request(app).post('/api/bookings').send(booking)).status).toBe(409);

    await desk.delete(`/api/admin/closures/${res.body.closure.id}`);
    expect(await slotsOn('2026-10-07')).toContain('09:00');
  });

  it('a daily lunch break blocks only the slots that overlap it', async () => {
    const desk = await login('desk@clinic.test');
    await desk.post('/api/admin/closures').send({ startDate: '2026-10-06', repeat: 'daily', startTime: '12:00', endTime: '13:00', reason: 'Lunch' });
    for (const d of ['2026-10-07', '2026-10-08', '2026-10-10']) {
      const slots = await slotsOn(d);
      expect(slots).toContain('11:00');
      expect(slots).not.toContain('11:30'); // 11:30–12:30 runs into lunch
      expect(slots).not.toContain('12:00');
      expect(slots).not.toContain('12:30');
      expect(slots).toContain('13:00');
    }
  });

  it('a weekly closure applies only on that weekday', async () => {
    const desk = await login('desk@clinic.test');
    await desk.post('/api/admin/closures').send({ startDate: '2026-10-10', repeat: 'weekly' }); // Saturdays
    expect(await slotsOn('2026-10-10')).toEqual([]);
    expect(await slotsOn('2026-10-17')).toEqual([]);
    expect(await slotsOn('2026-10-12')).toContain('09:00');
  });

  it('a date range closes every day in it', async () => {
    const desk = await login('desk@clinic.test');
    await desk.post('/api/admin/closures').send({ startDate: '2026-10-07', endDate: '2026-10-10', reason: 'Seminar' });
    expect(await slotsOn('2026-10-07')).toEqual([]);
    expect(await slotsOn('2026-10-10')).toEqual([]);
    expect(await slotsOn('2026-10-12')).toContain('09:00');
  });

  it('previews which bookings a closure would affect', async () => {
    await requestBooking({ preferredTime: '12:00' });
    await requestBooking({ mobile: nextMobile(), preferredTime: '14:00' });
    const desk = await login('desk@clinic.test');
    const res = await desk.post('/api/admin/closures/preview').send({ startDate: '2026-10-07', startTime: '11:30', endTime: '13:00' });
    expect(res.body.affected).toHaveLength(1);
    expect(res.body.affected[0]).toMatchObject({ fullName: 'Maria Santos', startAt: '2026-10-07T04:00:00.000Z' });
  });

  it('validates closures', async () => {
    const desk = await login('desk@clinic.test');
    const bad = [
      { startDate: 'soon' },
      { startDate: '2026-10-07', endDate: '2026-10-01' },
      { startDate: '2026-10-07', startTime: '12:00' },
      { startDate: '2026-10-07', startTime: '13:00', endTime: '12:00' },
      { startDate: '2026-10-07', repeat: 'monthly' },
    ];
    for (const body of bad) expect((await desk.post('/api/admin/closures').send(body)).status, JSON.stringify(body)).toBe(400);
    expect((await request(app).post('/api/admin/closures').send({ startDate: '2026-10-07' })).status).toBe(401);
  });

  it('shows closures in the day schedule', async () => {
    const desk = await login('desk@clinic.test');
    await desk.post('/api/admin/closures').send({ startDate: '2026-10-06', repeat: 'daily', startTime: '12:00', endTime: '13:00', reason: 'Lunch' });
    const res = await desk.get('/api/admin/schedule?date=2026-10-07');
    expect(res.body.closures).toEqual([expect.objectContaining({ startTime: '12:00', endTime: '13:00', reason: 'Lunch' })]);
    expect((await desk.get('/api/admin/schedule?date=2026-10-09')).body.closures).toHaveLength(1);
  });
});

describe('new-request alerts', () => {
  it('reports patient actions since a moment, but not staff actions', async () => {
    const desk = await login('desk@clinic.test');
    const first = await desk.get('/api/admin/updates');
    expect(first.body).toMatchObject({ pending: 0, events: [] });
    const since = first.body.serverTime;

    now = new Date(now.getTime() + 60_000);
    const { id } = await requestBooking();
    await desk.post('/api/admin/bookings').send({
      fullName: 'Walk In',
      mobile: '09180000000',
      service: 'Consultation / check-up',
      startAt: '2026-10-07T10:00',
      durationMinutes: 60,
    });

    const res = await desk.get(`/api/admin/updates?since=${encodeURIComponent(since)}`);
    expect(res.body.pending).toBe(1);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ actorType: 'patient', action: 'booking.requested', bookingId: id });
    expect((await request(app).get('/api/admin/updates')).status).toBe(401);
  });
});

describe('patient self-service', () => {
  it('finds a booking only with the right reference and mobile', async () => {
    const { reference } = await requestBooking();
    const ok = await request(app).post('/api/manage/lookup').send({ reference: reference.toLowerCase(), mobile: '+63 917 123 4567' });
    expect(ok.status).toBe(200);
    expect(ok.body.booking).toMatchObject({ reference, firstName: 'Maria', status: 'pending', canChange: true });
    expect(ok.body.booking.mobile).toBeUndefined();
    expect(ok.body.booking.staffNotes).toBeUndefined();

    expect((await request(app).post('/api/manage/lookup').send({ reference, mobile: '0999 999 9999' })).status).toBe(404);
    expect((await request(app).post('/api/manage/lookup').send({ reference: 'nope', mobile: '0917 123 4567' })).status).toBe(400);
  });

  it('lets the patient cancel, which frees the slot and alerts staff', async () => {
    const { id, reference } = await requestBooking();
    await requestBooking({ mobile: nextMobile() }); // 9:00 now full (capacity 2)
    expect(await slotsOn('2026-10-07')).not.toContain('09:00');

    const res = await request(app).post('/api/manage/cancel').send({ ...PATIENT_ID, reference });
    expect(res.body.booking).toMatchObject({ status: 'cancelled', canChange: false });
    expect(await slotsOn('2026-10-07')).toContain('09:00');

    const admin = await login();
    const detail = (await admin.get(`/api/admin/bookings/${id}`)).body;
    expect(detail.activity[0]).toMatchObject({ actorType: 'patient', action: 'booking.cancelled_by_patient' });
  });

  it('lets the patient reschedule a confirmed booking; it goes back to pending', async () => {
    const { id, reference } = await requestBooking();
    const admin = await login();
    await admin.patch(`/api/admin/bookings/${id}`).send({ status: 'confirmed', durationMinutes: 90 });

    const avail = await request(app).post('/api/manage/availability').send({ ...PATIENT_ID, reference });
    expect(avail.body.durationMinutes).toBe(90);

    const res = await request(app)
      .post('/api/manage/reschedule')
      .send({ ...PATIENT_ID, reference, preferredDate: '2026-10-08', preferredTime: '14:00' });
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ status: 'pending', startAt: '2026-10-08T06:00:00.000Z', durationMinutes: 90 });
  });

  it('ignores the patient’s own booking when checking a reschedule slot', async () => {
    const { reference } = await requestBooking();
    await requestBooking({ mobile: nextMobile() }); // 9:00 now full, including Maria
    const res = await request(app)
      .post('/api/manage/reschedule')
      .send({ ...PATIENT_ID, reference, preferredDate: '2026-10-07', preferredTime: '09:30' });
    expect(res.status).toBe(200); // 9:30 overlaps only the other booking once Maria moves
  });

  it('refuses changes on the day of the appointment, and for closed or taken slots', async () => {
    const { reference } = await requestBooking();
    for (let i = 0; i < 2; i++) await requestBooking({ mobile: nextMobile(), preferredDate: '2026-10-08' });
    const taken = await request(app)
      .post('/api/manage/reschedule')
      .send({ ...PATIENT_ID, reference, preferredDate: '2026-10-08', preferredTime: '09:00' });
    expect(taken.status).toBe(409);
    const friday = await request(app)
      .post('/api/manage/reschedule')
      .send({ ...PATIENT_ID, reference, preferredDate: '2026-10-09', preferredTime: '09:00' });
    expect(friday.status).toBe(400);

    now = new Date('2026-10-07T00:00:00Z'); // 8 AM Manila on the appointment day
    const lookup = await request(app).post('/api/manage/lookup').send({ ...PATIENT_ID, reference });
    expect(lookup.body.booking.canChange).toBe(false);
    expect((await request(app).post('/api/manage/cancel').send({ ...PATIENT_ID, reference })).status).toBe(409);
  });
});

describe('returning patients', () => {
  it('shows history and visit counts by mobile number', async () => {
    const admin = await login();
    const past = await admin.post('/api/admin/bookings').send({
      fullName: 'Maria S.',
      mobile: '0917 123 4567',
      service: 'Check-ups & Cleaning',
      startAt: '2026-09-01T10:00',
      durationMinutes: 60,
    });
    await admin.patch(`/api/admin/bookings/${past.body.booking.id}`).send({ status: 'completed' });
    const missed = await admin.post('/api/admin/bookings').send({
      fullName: 'Maria S.',
      mobile: '0917 123 4567',
      service: 'Check-ups & Cleaning',
      startAt: '2026-09-15T10:00',
      durationMinutes: 60,
    });
    await admin.patch(`/api/admin/bookings/${missed.body.booking.id}`).send({ status: 'no_show' });

    const { id } = await requestBooking();
    await requestBooking({ fullName: 'Jose Reyes', mobile: '09281112233' });

    const list = (await admin.get('/api/admin/bookings?view=action')).body.bookings;
    expect(list.find((b: { id: number }) => b.id === id).patient).toEqual({ previousVisits: 2, noShows: 1 });
    expect(list.find((b: { fullName: string }) => b.fullName === 'Jose Reyes').patient).toEqual({ previousVisits: 0, noShows: 0 });

    const detail = (await admin.get(`/api/admin/bookings/${id}`)).body;
    expect(detail.history.map((b: { status: string }) => b.status)).toEqual(['no_show', 'completed']);

    const lookup = (await admin.get('/api/admin/patients/lookup?mobile=%2B639171234567')).body.patient;
    expect(lookup).toMatchObject({ fullName: 'Maria Santos', visits: 1, noShows: 1, lastVisit: '2026-09-01T02:00:00.000Z' });
    expect((await admin.get('/api/admin/patients/lookup?mobile=09990000000')).body.patient).toBeNull();
  });
});

describe('activity log', () => {
  it('records who did what on a booking', async () => {
    const { id } = await requestBooking();
    const admin = await login();
    await admin.patch(`/api/admin/bookings/${id}`).send({ status: 'confirmed', startAt: '2026-10-07T10:00' });
    await admin.patch(`/api/admin/bookings/${id}`).send({ staffNotes: 'Called' });
    const activity = (await admin.get(`/api/admin/bookings/${id}`)).body.activity;
    expect(activity.map((a: { actor: string; summary: string }) => `${a.actor}: ${a.summary}`)).toEqual([
      'Rose: Updated staff notes',
      expect.stringMatching(/^Rose: Confirmed for Wed, Oct 7.*10:00 AM \(1 hour\)$/),
      expect.stringMatching(/^Patient: Requested online for/),
    ]);
  });

  it('is admin-only as a full feed', async () => {
    const desk = await login('desk@clinic.test');
    expect((await desk.get('/api/admin/activity')).status).toBe(403);
    const admin = await login();
    expect((await admin.get('/api/admin/activity')).status).toBe(200);
  });
});

describe('staff accounts', () => {
  it('lets admins add staff; staff can sign in but not manage accounts', async () => {
    const admin = await login();
    const res = await admin
      .post('/api/admin/users')
      .send({ name: 'Jen', email: 'JEN@clinic.test', role: 'staff', password: 'a-long-password' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'jen@clinic.test', role: 'staff', active: true });
    expect((await admin.post('/api/admin/users').send({ name: 'Jen 2', email: 'jen@clinic.test', password: 'a-long-password' })).status).toBe(409);
    expect((await admin.post('/api/admin/users').send({ name: 'X', email: 'x@clinic.test', password: 'short' })).status).toBe(400);

    const jen = await login('jen@clinic.test', 'a-long-password');
    expect((await jen.get('/api/admin/bookings')).status).toBe(200);
    expect((await jen.get('/api/admin/users')).status).toBe(403);
    expect((await jen.post('/api/admin/users').send({ name: 'Y', email: 'y@c.test', password: 'a-long-password' })).status).toBe(403);
  });

  it('deactivating signs the person out and blocks sign-in', async () => {
    const admin = await login();
    const desk = await login('desk@clinic.test');
    const deskId = (db.prepare("SELECT id FROM users WHERE email = 'desk@clinic.test'").get() as { id: number }).id;
    await admin.patch(`/api/admin/users/${deskId}`).send({ active: false });
    expect((await desk.get('/api/admin/bookings')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'desk@clinic.test', password: 'correct-horse-battery' })).status).toBe(401);
  });

  it('protects against locking the clinic out', async () => {
    const admin = await login();
    const meId = (db.prepare("SELECT id FROM users WHERE email = 'staff@clinic.test'").get() as { id: number }).id;
    expect((await admin.patch(`/api/admin/users/${meId}`).send({ active: false })).status).toBe(409);
    expect((await admin.patch(`/api/admin/users/${meId}`).send({ role: 'staff' })).status).toBe(409);
  });

  it('an admin can reset a password, which signs the person out', async () => {
    const admin = await login();
    const desk = await login('desk@clinic.test');
    const deskId = (db.prepare("SELECT id FROM users WHERE email = 'desk@clinic.test'").get() as { id: number }).id;
    await admin.patch(`/api/admin/users/${deskId}`).send({ password: 'brand-new-password' });
    expect((await desk.get('/api/admin/bookings')).status).toBe(401);
    await login('desk@clinic.test', 'brand-new-password');
  });

  it('anyone can change their own password and stay signed in', async () => {
    const desk = await login('desk@clinic.test');
    const wrong = await desk.post('/api/auth/password').send({ currentPassword: 'nope', newPassword: 'another-long-password' });
    expect(wrong.status).toBe(400);
    const ok = await desk.post('/api/auth/password').send({ currentPassword: 'correct-horse-battery', newPassword: 'another-long-password' });
    expect(ok.status).toBe(204);
    expect((await desk.get('/api/admin/bookings')).status).toBe(200);
    await login('desk@clinic.test', 'another-long-password');
  });
});

describe('reports', () => {
  it('summarises a period', async () => {
    const admin = await login();
    const a = await requestBooking(); // Wed 9:00 online
    const b = await requestBooking({ mobile: nextMobile(), preferredDate: '2026-10-08', preferredTime: '14:00', service: 'Root Canal Treatment' });
    const c = await requestBooking({ mobile: nextMobile(), preferredDate: '2026-10-08', preferredTime: '15:00' });
    await admin.post('/api/admin/bookings').send({
      fullName: 'Walk In',
      mobile: '0917 123 4567', // same as Maria → returning
      service: 'Check-ups & Cleaning',
      startAt: '2026-10-10T10:00',
      durationMinutes: 60,
    });
    await admin.patch(`/api/admin/bookings/${a.id}`).send({ status: 'confirmed' });
    await admin.patch(`/api/admin/bookings/${a.id}`).send({ status: 'completed' });
    await admin.patch(`/api/admin/bookings/${b.id}`).send({ status: 'confirmed' });
    await admin.patch(`/api/admin/bookings/${b.id}`).send({ status: 'no_show' });
    await admin.patch(`/api/admin/bookings/${c.id}`).send({ status: 'cancelled' });

    const r = (await admin.get('/api/admin/reports?from=2026-10-01&to=2026-10-31')).body;
    expect(r.totals).toEqual({
      requestsOnline: 3,
      addedByStaff: 1,
      appointments: 3,
      completed: 1,
      noShows: 1,
      cancelled: 1,
      newPatients: 2,
      returningPatients: 1,
    });
    expect(r.byService[0]).toEqual({ service: 'Check-ups & Cleaning', count: 2 });
    expect(r.byWeekday.find((d: { weekday: number }) => d.weekday === 4)).toEqual({ weekday: 4, count: 1 });
    expect(r.byWeekday.map((d: { weekday: number }) => d.weekday)).toEqual([1, 2, 3, 4, 6]);
    expect(r.byHour.find((h: { hour: number }) => h.hour === 9)).toEqual({ hour: 9, count: 1 });
    expect((await admin.get('/api/admin/reports?from=2026-10-31&to=2026-10-01')).status).toBe(400);
  });
});

describe('calendar', () => {
  it('returns non-cancelled bookings and closures for a range', async () => {
    const admin = await login();
    await requestBooking();
    const { id } = await requestBooking({ mobile: nextMobile(), preferredTime: '10:00' });
    await admin.patch(`/api/admin/bookings/${id}`).send({ status: 'cancelled' });
    await admin.post('/api/admin/closures').send({ startDate: '2026-10-08', reason: 'Holiday' });

    const res = await admin.get('/api/admin/calendar?from=2026-10-05&to=2026-10-11');
    expect(res.body.capacity).toBe(2);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.closures).toEqual([expect.objectContaining({ startDate: '2026-10-08', reason: 'Holiday' })]);
    expect((await admin.get('/api/admin/calendar?from=2026-10-01&to=2026-12-31')).status).toBe(400);
  });
});

describe('database upgrade to v3', () => {
  it('keeps existing staff as admins and bookings as online', () => {
    const old = new DatabaseSync(':memory:');
    old.exec(MIGRATIONS[0]);
    old.exec(MIGRATIONS[1]);
    old.exec('PRAGMA user_version = 2');
    old.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES ('a@b.c', 'A', 'x', 't')").run();
    old
      .prepare(
        `INSERT INTO bookings (reference, full_name, mobile, service, start_at, created_at, updated_at)
         VALUES ('BD-AAAAA', 'X', '09170000000', 'Check-ups & Cleaning', '2026-10-07T01:00:00.000Z', 't', 't')`,
      )
      .run();
    migrate(old);
    expect(old.prepare('SELECT role, active FROM users').get()).toEqual({ role: 'admin', active: 1 });
    expect(old.prepare('SELECT source FROM bookings').get()).toEqual({ source: 'online' });
  });
});
