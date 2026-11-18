// Assigning patients to dentists: availability, auto-assignment, staff tools, "my patients", reports.
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { createUser } from './auth.ts';
import { migrate, MIGRATIONS, openDb, type Db } from './db.ts';

let now = new Date('2026-10-06T02:00:00Z'); // Tue 6 Oct, 10 AM Manila
let db: Db;
let app: ReturnType<typeof createApp>;
let drA: number; // Mon–Thu, Sat
let drB: number; // Thu, Sat only

const WED = '2026-10-07';
const THU = '2026-10-08';
const booking = {
  fullName: 'Maria Santos',
  mobile: '0917 123 4567',
  service: 'Check-ups & Cleaning',
  preferredDate: THU,
  preferredTime: '09:00',
  notes: '',
  consent: true,
};

let n = 0;
const nextMobile = () => `0917000${String(1000 + n++).slice(-4)}`;

async function login(email = 'admin@clinic.test') {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: 'correct-horse-battery' });
  expect(res.status).toBe(200);
  return agent;
}

async function requestBooking(over: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/bookings').send({ ...booking, mobile: nextMobile(), ...over });
  return res;
}

const slots = async (date: string, dentist: number | 'any' = 'any'): Promise<string[]> =>
  (await request(app).get(`/api/availability?dentist=${dentist}`)).body.days[date];

const dentistOf = (reference: string) =>
  (db.prepare('SELECT dentist_id FROM bookings WHERE reference = ?').get(reference) as { dentist_id: number | null }).dentist_id;

beforeEach(async () => {
  now = new Date('2026-10-06T02:00:00Z');
  db = openDb(':memory:');
  await createUser(db, 'admin@clinic.test', 'Rose', 'correct-horse-battery', 'admin');
  await createUser(db, 'desk@clinic.test', 'Desk', 'correct-horse-battery', 'staff');
  const drUser = await createUser(db, 'dr.a@clinic.test', 'Dr. A', 'correct-horse-battery', 'staff');
  app = createApp({ db, now: () => now, rateLimits: false });
  const admin = await login();
  drA = (await admin.post('/api/admin/dentists').send({ name: 'Dr. A', workingDays: [1, 2, 3, 4, 6], userId: drUser.id })).body.dentist.id;
  drB = (await admin.post('/api/admin/dentists').send({ name: 'Dr. B', workingDays: [4, 6] })).body.dentist.id;
});

describe('dentist setup', () => {
  it('lists dentists publicly without private fields, with distinct colours for staff', async () => {
    const pub = (await request(app).get('/api/dentists')).body.dentists;
    expect(pub).toEqual([
      { id: drA, name: 'Dr. A', workingDays: [1, 2, 3, 4, 6] },
      { id: drB, name: 'Dr. B', workingDays: [4, 6] },
    ]);
    const admin = await login();
    const all = (await admin.get('/api/admin/dentists')).body.dentists;
    expect(new Set(all.map((d: { color: string }) => d.color)).size).toBe(2);
  });

  it('only admins manage dentists; a login links to one dentist at most', async () => {
    const desk = await login('desk@clinic.test');
    expect((await desk.get('/api/admin/dentists')).status).toBe(200);
    expect((await desk.post('/api/admin/dentists').send({ name: 'Dr. C', workingDays: [1] })).status).toBe(403);

    const admin = await login();
    const drUserId = (db.prepare("SELECT id FROM users WHERE email = 'dr.a@clinic.test'").get() as { id: number }).id;
    expect((await admin.patch(`/api/admin/dentists/${drB}`).send({ userId: drUserId })).status).toBe(409);
    expect((await admin.post('/api/admin/dentists').send({ name: 'X', workingDays: [] })).status).toBe(400);
  });

  it('tells a linked dentist who they are', async () => {
    const dr = await login('dr.a@clinic.test');
    expect((await dr.get('/api/auth/me')).body.user).toMatchObject({ dentistId: drA });
    const desk = await login('desk@clinic.test');
    expect((await desk.get('/api/auth/me')).body.user.dentistId).toBeNull();
  });
});

describe('online booking with dentists', () => {
  it('only offers days a dentist works, one patient per dentist at a time', async () => {
    // Wednesday: only Dr. A works, so one booking fills 9:00 even though capacity is 2.
    const first = await requestBooking({ preferredDate: WED });
    expect(first.status).toBe(201);
    expect(dentistOf(first.body.reference)).toBe(drA);
    expect(await slots(WED)).not.toContain('09:00');
    expect((await requestBooking({ preferredDate: WED })).status).toBe(409);

    // Thursday: both work, so two fit at 9:00, the third doesn't.
    const t1 = await requestBooking();
    const t2 = await requestBooking();
    expect([dentistOf(t1.body.reference), dentistOf(t2.body.reference)].sort()).toEqual([drA, drB].sort());
    expect((await requestBooking()).status).toBe(409);
  });

  it('lets patients ask for a specific dentist', async () => {
    expect(await slots(WED, drB)).toEqual([]); // Dr. B doesn't work Wednesdays
    const res = await requestBooking({ dentistId: drB });
    expect(res.status).toBe(201);
    expect(res.body.dentistName).toBe('Dr. B');
    const row = db.prepare('SELECT dentist_id, dentist_requested FROM bookings WHERE reference = ?').get(res.body.reference);
    expect(row).toEqual({ dentist_id: drB, dentist_requested: 1 });

    expect(await slots(THU, drB)).not.toContain('09:00');
    expect(await slots(THU, drA)).toContain('09:00');
    expect((await requestBooking({ dentistId: drB })).status).toBe(409);
    expect((await requestBooking({ dentistId: 999 })).status).toBe(400);
  });

  it('keeps patients with their regular dentist when they choose “any”', async () => {
    const admin = await login();
    const first = await requestBooking({ mobile: '09171234567', dentistId: drB });
    const id = (db.prepare('SELECT id FROM bookings WHERE reference = ?').get(first.body.reference) as { id: number }).id;
    await admin.patch(`/api/admin/bookings/${id}`).send({ status: 'confirmed' });
    const again = await requestBooking({ mobile: '09171234567', preferredDate: '2026-10-10', preferredTime: '10:00' });
    expect(dentistOf(again.body.reference)).toBe(drB);
  });

  it('a dentist’s time off blocks only them', async () => {
    const admin = await login();
    await admin.post('/api/admin/closures').send({ startDate: THU, dentistId: drA, reason: 'Leave' });
    const res = await requestBooking();
    expect(dentistOf(res.body.reference)).toBe(drB);
    expect(await slots(THU, drA)).toEqual([]);
    expect(await slots(WED)).toContain('09:00'); // leave is only on Thursday
  });
});

describe('staff tools', () => {
  it('adds, reassigns and filters by dentist, with activity log entries', async () => {
    const admin = await login();
    const add = await admin.post('/api/admin/bookings').send({
      fullName: 'Walk In',
      mobile: '0918 222 3333',
      service: 'Consultation / check-up',
      startAt: `${THU}T10:00`,
      durationMinutes: 60,
      dentistId: drA,
    });
    expect(add.body.booking).toMatchObject({ dentistId: drA, dentistRequested: false });
    expect((await admin.post('/api/admin/bookings').send({ ...add.body.booking, startAt: `${THU}T11:00`, mobile: '0918 222 3333', dentistId: 999 })).status).toBe(400);

    const id = add.body.booking.id;
    const moved = await admin.patch(`/api/admin/bookings/${id}`).send({ dentistId: drB });
    expect(moved.body.booking.dentistId).toBe(drB);
    const detail = (await admin.get(`/api/admin/bookings/${id}`)).body;
    expect(detail.activity[0].summary).toBe('Assigned to Dr. B');

    const forB = (await admin.get(`/api/admin/bookings?view=all&dentist=${drB}`)).body;
    expect(forB.bookings.map((b: { id: number }) => b.id)).toEqual([id]);
    expect(forB.counts.all).toBe(1);
    expect((await admin.get(`/api/admin/bookings?view=all&dentist=${drA}`)).body.bookings).toEqual([]);
  });

  it('clears “patient asked for” when staff move the patient to someone else', async () => {
    const admin = await login();
    const res = await requestBooking({ dentistId: drB });
    const id = (db.prepare('SELECT id FROM bookings WHERE reference = ?').get(res.body.reference) as { id: number }).id;
    const r = await admin.patch(`/api/admin/bookings/${id}`).send({ dentistId: drA });
    expect(r.body.booking).toMatchObject({ dentistId: drA, dentistRequested: false });
  });

  it('auto-assigns unassigned bookings to free dentists without double-booking anyone', async () => {
    const insert = db.prepare(
      `INSERT INTO bookings (reference, full_name, mobile, service, start_at, created_at, updated_at)
       VALUES (?, 'Old', ?, 'Check-ups & Cleaning', ?, 't', 't')`,
    );
    // Thursday 9:00 ×3 (only two dentists) and Wednesday 9:00 (only Dr. A works).
    insert.run('BD-OLD21', '09170000001', '2026-10-08T01:00:00.000Z');
    insert.run('BD-OLD22', '09170000002', '2026-10-08T01:00:00.000Z');
    insert.run('BD-OLD23', '09170000003', '2026-10-08T01:00:00.000Z');
    insert.run('BD-OLD24', '09170000004', '2026-10-07T01:00:00.000Z');
    const admin = await login();
    expect((await admin.get('/api/admin/dentists')).body.unassignedUpcoming).toBe(4);
    expect((await admin.get('/api/admin/bookings?view=all&dentist=unassigned')).body.bookings).toHaveLength(4);

    const res = await admin.post('/api/admin/dentists/auto-assign');
    expect(res.body).toEqual({ assigned: 3, left: 1 });
    const thu = db.prepare("SELECT dentist_id FROM bookings WHERE reference IN ('BD-OLD21','BD-OLD22','BD-OLD23') ORDER BY reference").all() as Array<{ dentist_id: number | null }>;
    expect(thu.map((r) => r.dentist_id).sort()).toEqual([drA, drB, null].sort());
    expect(dentistOf('BD-OLD24')).toBe(drA);
    expect((await admin.get('/api/admin/dentists')).body.unassignedUpcoming).toBe(1);
    const desk = await login('desk@clinic.test');
    expect((await desk.post('/api/admin/dentists/auto-assign')).status).toBe(403);
  });

  it('suggests the patient’s regular dentist in the staff form lookup', async () => {
    const admin = await login();
    const add = await admin.post('/api/admin/bookings').send({
      fullName: 'Maria Santos',
      mobile: '0917 123 4567',
      service: 'Consultation / check-up',
      startAt: '2026-09-10T10:00',
      durationMinutes: 60,
      dentistId: drB,
    });
    await admin.patch(`/api/admin/bookings/${add.body.booking.id}`).send({ status: 'completed' });
    const lookup = (await admin.get('/api/admin/patients/lookup?mobile=09171234567')).body.patient;
    expect(lookup.regularDentistId).toBe(drB);
  });
});

describe('patients changing their booking', () => {
  it('stays with the dentist they asked for; “any” bookings can move to whoever is free', async () => {
    const asked = await requestBooking({ mobile: '0917 555 0001', dentistId: drB });
    const avail = await request(app).post('/api/manage/availability').send({ reference: asked.body.reference, mobile: '0917 555 0001' });
    expect(avail.body.days[WED]).toEqual([]); // Dr. B is off on Wednesdays

    const anyone = await requestBooking({ mobile: '0917 555 0002' });
    const moved = await request(app)
      .post('/api/manage/reschedule')
      .send({ reference: anyone.body.reference, mobile: '0917 555 0002', preferredDate: WED, preferredTime: '10:00' });
    expect(moved.status).toBe(200);
    expect(moved.body.booking.dentistName).toBe('Dr. A');
  });
});

describe('reports by dentist', () => {
  it('counts appointments per dentist, including unassigned', async () => {
    await requestBooking();
    await requestBooking();
    await requestBooking({ preferredDate: WED });
    db.prepare(
      `INSERT INTO bookings (reference, full_name, mobile, service, start_at, created_at, updated_at)
       VALUES ('BD-OLD33', 'Old', '09170000002', 'Check-ups & Cleaning', '2026-10-09T01:00:00.000Z', 't', 't')`,
    ).run();
    const admin = await login();
    const r = (await admin.get('/api/admin/reports?from=2026-10-01&to=2026-10-31')).body;
    expect(r.byDentist).toEqual([
      { dentistId: drA, name: 'Dr. A', count: 2 },
      { dentistId: drB, name: 'Dr. B', count: 1 },
      { dentistId: null, name: 'Unassigned', count: 1 },
    ]);
  });
});

describe('database upgrade to v4', () => {
  it('leaves existing bookings unassigned', () => {
    const old = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
    old.exec('PRAGMA user_version = 3');
    old
      .prepare(
        `INSERT INTO bookings (reference, full_name, mobile, service, start_at, created_at, updated_at)
         VALUES ('BD-AAAAA', 'X', '09170000000', 'Check-ups & Cleaning', '2026-10-07T01:00:00.000Z', 't', 't')`,
      )
      .run();
    migrate(old);
    expect(old.prepare('SELECT dentist_id, dentist_requested FROM bookings').get()).toEqual({ dentist_id: null, dentist_requested: 0 });
  });
});
