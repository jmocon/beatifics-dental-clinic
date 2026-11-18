// Records the three showcase scenes with Playwright. Expects the app running at `base` with the video seed.
// Called by run.ts.
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { manilaLocalToUtcIso, weekdayOf } from '../../shared/dates.ts';
import { OVERLAY_SCRIPT, stageHtml } from './overlay.ts';

let BASE = '';
let OUT = '';
const PATIENT = { name: 'Carla Villanueva', mobile: '0917 888 2024', service: 'Check-ups & Cleaning', dentist: 'Dr. Jessica Vinuya' };
const STAFF = { email: 'admin@beatifics.local', password: 'beatifics-demo' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SceneResult {
  file: string;
  /** Seconds of blank/loading video at the start to trim. */
  trimStart: number;
}

/** Moves our drawn cursor and the real mouse together, then clicks. Works for elements inside the phone iframe too. */
class Director {
  constructor(readonly page: Page) {}

  async smoothScrollTo(target: Locator, block: 'center' | 'start' = 'center') {
    await target.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b as ScrollLogicalPosition }), block);
    await sleep(900);
  }

  async moveTo(target: Locator, ms = 700) {
    const box = await target.boundingBox();
    if (!box) throw new Error(`Not visible: ${target}`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.cursor(x, y, ms);
    return { x, y };
  }

  async cursor(x: number, y: number, ms = 700) {
    await this.page.evaluate(([x, y, ms]) => (window as any).__overlay?.move(x, y, ms), [x, y, ms] as const);
    await this.page.mouse.move(x, y, { steps: 12 });
    await sleep(ms + 80);
  }

  async click(target: Locator, opts: { scroll?: boolean; ms?: number } = {}) {
    await target.waitFor({ state: 'visible' });
    if (opts.scroll !== false) await this.ensureInView(target);
    const { x, y } = await this.moveTo(target, opts.ms);
    await this.clickAt(x, y);
  }

  async clickAt(x: number, y: number) {
    await this.page.evaluate(([x, y]) => (window as any).__overlay?.ripple(x, y), [x, y] as const);
    await this.page.mouse.click(x, y);
    await sleep(250);
  }

  async ensureInView(target: Locator) {
    const visible = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 70 && r.bottom <= window.innerHeight - 110;
    });
    if (!visible) await this.smoothScrollTo(target);
  }

  async type(target: Locator, text: string, delay = 65) {
    await this.click(target);
    await target.pressSequentially(text, { delay });
    await sleep(300);
  }

  /** Bottom caption pill (desktop scenes). */
  async caption(html: string, hold = 0) {
    await this.page.evaluate((h) => (window as any).__overlay?.caption(h), html);
    if (hold) await sleep(hold);
  }

  /** Side text next to the phone (phone scenes). */
  async step(eyebrow: string, title: string, sub: string, hold = 0) {
    await this.page.evaluate(([e, t, s]) => (window as any).setStep(e, t, s), [eyebrow, title, sub] as const);
    if (hold) await sleep(hold);
  }
}

async function newContext(browser: Browser, kind: 'phone' | 'desktop'): Promise<BrowserContext> {
  const ctx = await browser.newContext(
    kind === 'desktop'
      ? // Recorded at 1440×810 (a typical laptop) and scaled to 1080p when composing; video frames ignore deviceScaleFactor.
        { viewport: { width: 1440, height: 810 }, recordVideo: { dir: OUT, size: { width: 1440, height: 810 } } }
      : { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } },
  );
  await ctx.addInitScript(OVERLAY_SCRIPT);
  // Serve the phone "stage" page, and let it frame the site (the app sends X-Frame-Options: DENY; recording only).
  await ctx.route(`${BASE}/**`, async (route) => {
    const req = route.request();
    if (req.url().startsWith(`${BASE}/__stage`)) {
      return route.fulfill({ contentType: 'text/html', body: stageHtml(decodeURIComponent(new URL(req.url()).searchParams.get('src') ?? '/')) });
    }
    if (req.resourceType() !== 'document') return route.continue();
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers['x-frame-options'];
    return route.fulfill({ response: res, headers });
  });
  return ctx;
}

async function finish(ctx: BrowserContext, page: Page, name: string, startedAt: number, readyAt: number): Promise<SceneResult> {
  const video = page.video()!;
  await ctx.close();
  const file = join(OUT, `${name}.webm`);
  renameSync(await video.path(), file);
  return { file, trimStart: Math.max(0, (readyAt - startedAt) / 1000 - 0.1) };
}

// ---------------- Scene 1: a patient books on their phone ----------------
async function scenePatientBooks(browser: Browser): Promise<SceneResult & { reference: string; date: string; time: string }> {
  const ctx = await newContext(browser, 'phone');
  const startedAt = Date.now();
  const page = await ctx.newPage();
  const d = new Director(page);
  await page.goto(`${BASE}/__stage?src=${encodeURIComponent('/')}`);
  const app = page.frameLocator('#app');
  await app.locator('#hero-title').waitFor();
  await page.evaluate(() => (window as any).__overlay.touch());
  await d.step('For patients', 'The clinic, <em>online</em>', 'A fast, phone-friendly website in the clinic’s own look.');
  await sleep(1200);
  const readyAt = Date.now() - 300;
  await sleep(2600);

  // A short scroll through the page.
  await d.step('For patients', 'Everything a patient needs', 'Services, the dentist, opening hours and directions on one page.');
  for (const id of ['#services', '#about', '#visit']) {
    await d.smoothScrollTo(app.locator(id), 'start');
    await sleep(1300);
  }

  await d.step('Book in under a minute', 'Request an <em>appointment</em>', 'No account, no app to install. Just a few fields.');
  await d.smoothScrollTo(app.locator('#book-title'), 'start');
  await sleep(1400);
  const form = app.locator('form.booking-form');
  await d.type(form.locator('input[name="fullName"]'), PATIENT.name);
  await d.type(form.locator('input[name="mobile"]'), PATIENT.mobile, 70);
  await d.click(form.locator('select[name="service"]'));
  await form.locator('select[name="service"]').selectOption(PATIENT.service);
  await sleep(600);

  await d.step('Book in under a minute', 'Pick a dentist, day and <em>time</em>', 'Only times that are really free are shown, based on the clinic’s live schedule.');
  await d.click(form.locator('.choice-chip', { hasText: PATIENT.dentist }));
  await sleep(500);
  // Not tomorrow, and preferably a day both dentists work, so the calendar later shows two columns.
  const days = form.locator('.day-chip:not(.is-full):not(.day-chip-other)');
  const values = await days.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  const idx = Math.max(1, values.findIndex((v, i) => i >= 1 && [2, 4, 6].includes(weekdayOf(v))));
  const day = days.nth(idx);
  const date = values[idx];
  await d.click(day);
  await sleep(900);
  const afternoon = form.locator('.time-group', { hasText: 'Afternoon' }).locator('.time-slot');
  const slot = (await afternoon.count()) > 0 ? afternoon.first() : form.locator('.time-slot').first();
  const time = await slot.locator('input').inputValue();
  await d.click(slot);
  await sleep(700);
  await d.click(form.locator('label.consent'));
  await sleep(400);

  await d.step('Book in under a minute', 'Sent, with a <em>reference</em>', 'The clinic calls or texts to confirm. Patients can change or cancel online with the reference.');
  await d.click(form.locator('button[type="submit"]'));
  const done = app.locator('.booking-done');
  await done.waitFor();
  await d.smoothScrollTo(done, 'center');
  const reference = (await done.locator('.booking-ref strong').textContent())!.trim();
  await sleep(4500);

  const result = await finish(ctx, page, '1-patient-books', startedAt, readyAt);
  return { ...result, reference, date, time };
}

// ---------------- Scene 2: the clinic's admin portal ----------------
async function sceneAdmin(browser: Browser, booked: { date: string; time: string }): Promise<SceneResult> {
  const ctx = await newContext(browser, 'desktop');
  const startedAt = Date.now();
  const page = await ctx.newPage();
  const d = new Director(page);
  await page.goto(`${BASE}/admin`);
  await page.getByRole('heading', { name: 'Staff sign in' }).waitFor();
  await sleep(600);
  const readyAt = Date.now() - 200;
  await d.caption('<b>Admin portal</b> · private sign-in for clinic staff', 1500);
  await d.type(page.getByLabel('Email'), STAFF.email, 40);
  await d.type(page.getByLabel('Password', { exact: true }), STAFF.password, 40);
  await d.click(page.getByRole('button', { name: 'Sign in' }));
  await page.locator('.booking-item').first().waitFor();
  await sleep(500);

  await d.caption('New online requests land in <b>Needs action</b>, with a chime and a count in the tab', 1200);
  const carla = page.locator('.booking-item', { hasText: PATIENT.name });
  await d.moveTo(carla.locator('.row-tags'));
  await sleep(2400);

  await d.caption('Confirm the requested time <b>in one click</b>, right from the list');
  const jose = page.locator('.booking-item', { hasText: 'Jose Reyes' });
  await d.click(jose.locator('.row-confirm'));
  await sleep(2600);

  await d.caption('Or open a request to check details, adjust the time or dentist, then confirm');
  await d.click(carla.locator('.booking-row'));
  const detail = page.locator('.booking-detail-pane .detail');
  await detail.getByRole('heading', { name: PATIENT.name }).waitFor();
  await sleep(2800);
  await d.click(detail.getByRole('button', { name: 'Confirm appointment' }));
  await detail.locator('.flash .alert-success').waitFor();
  await d.caption('Confirmed. A ready-to-send text message is prepared, and <b>Next request →</b> keeps the queue moving', 4200);

  // Calendar
  await d.caption('');
  await d.click(page.locator('.admin-nav-link', { hasText: 'Calendar' }));
  await page.locator('.cal-toolbar').waitFor(); // today may be a closed day, with no timeline
  await sleep(700);
  await d.caption('The <b>Calendar</b> · arrow keys move day by day');
  const calDate = () => new URL(page.url()).searchParams.get('date');
  for (let i = 0; i < 12 && calDate() !== booked.date; i++) {
    await page.keyboard.press('ArrowRight');
    await sleep(calDate() === null ? 900 : 650);
  }
  if (calDate() !== booked.date) await page.goto(`${BASE}/admin/calendar?date=${booked.date}`);
  await page.locator('.timeline-cols').waitFor();
  await sleep(500);
  await d.caption('One column per dentist, lunch and other blocked times hatched', 3200);
  await d.moveTo(page.locator('.cal-block', { hasText: PATIENT.name }));
  await d.caption(`${PATIENT.name}’s new appointment is already on the calendar`, 3000);

  // Click an empty time to add a phone booking.
  const free = await findFreeTime(page, booked.date);
  if (free) {
    await d.caption('Phone call? <b>Click any free time</b> to add an appointment there');
    const col = page.locator('.timeline-col', { hasText: free.dentistName }).locator('.timeline-grid');
    const viewStart = await calendarViewStart(page);
    const target = async () => {
      const box = (await col.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + (free.minutes - viewStart) * 1.3 + 12 };
    };
    let { x, y } = await target();
    if (y > 810 - 150) {
      await page.mouse.wheel(0, y - 480);
      await sleep(900);
      ({ x, y } = await target());
    }
    await d.cursor(x, y, 900);
    await sleep(900);
    await d.clickAt(x, y);
    const hh = `${String(Math.floor(free.minutes / 60)).padStart(2, '0')}:${String(free.minutes % 60).padStart(2, '0')}`;
    await page.waitForURL(/\/calendar\/new/);
    if (!page.url().includes(`time=${encodeURIComponent(hh)}`) && !page.url().includes(`time=${hh}`)) console.warn(`  calendar click landed on ${page.url()}, expected ${hh}`);
    const form = page.locator('form.new-booking');
    await form.waitFor();
    await sleep(900);
    await d.caption('Returning patient? Type their number and the name <b>fills in by itself</b>');
    await form.locator('input[name="mobile"]').pressSequentially('0917 123 4567', { delay: 75 });
    await page.locator('.patient-found').waitFor();
    await sleep(2600);
    await d.click(form.getByRole('button', { name: 'Add appointment' }));
    await page.locator('.booking-detail-pane .flash .alert-success').waitFor();
    await d.caption('Added and confirmed: time, length and dentist were already filled from the click', 3200);
  }

  // Reports
  await d.caption('');
  await d.click(page.locator('.admin-nav-link', { hasText: 'Reports' }));
  await page.locator('.stat-label').first().waitFor();
  await d.caption('<b>Reports</b>: appointments, new vs returning patients, no-shows and busiest times');
  await sleep(700);
  await d.click(page.getByRole('tab', { name: 'Last 90 days' }));
  await sleep(1800);
  await page.mouse.wheel(0, 420);
  await sleep(2200);
  await page.mouse.wheel(0, 420);
  await sleep(2200);

  // Settings
  await d.caption('');
  await d.click(page.locator('.admin-nav-link', { hasText: 'Settings' }));
  await page.locator('.sub-tab').first().waitFor();
  await d.caption('<b>Settings</b>: time per patient, treatment lengths, dentists, blocked times and staff accounts');
  await sleep(2600);
  await d.click(page.locator('.sub-tab', { hasText: 'Dentists' }));
  await sleep(1200);
  await d.caption('Each dentist has their own working days and colour, and can sign in to see their own patients', 4200);
  await d.caption('');
  await sleep(500);

  return finish(ctx, page, '2-admin', startedAt, readyAt);
}

/** A free hour (for a dentist working that day) after the patient's booking, so the calendar click lands on empty space. */
async function findFreeTime(page: Page, date: string): Promise<{ dentistName: string; minutes: number } | null> {
  const [sched, dent] = await Promise.all([
    page.request.get(`${BASE}/api/admin/schedule?date=${date}`).then((r) => r.json()),
    page.request.get(`${BASE}/api/admin/dentists`).then((r) => r.json()),
  ]);
  const wd = weekdayOf(date);
  const working = (dent.dentists as Array<{ id: number; name: string; workingDays: number[]; active: boolean }>)
    .filter((x) => x.active && x.workingDays.includes(wd))
    .sort((a, b) => (a.name.includes('Marco') ? -1 : 0) - (b.name.includes('Marco') ? -1 : 0));
  const range = (startIso: string, mins: number) => ({ s: new Date(startIso).getTime(), e: new Date(startIso).getTime() + mins * 60_000 });
  const entries = (sched.entries as Array<{ startAt: string; durationMinutes: number; dentistId: number | null; status: string }>)
    .filter((e) => e.status === 'pending' || e.status === 'confirmed')
    .map((e) => ({ ...range(e.startAt, e.durationMinutes), dentistId: e.dentistId }));
  for (const dentist of working) {
    for (const t of ['15:00', '16:00', '14:00', '10:00', '11:00', '09:00']) {
      const r = range(manilaLocalToUtcIso(`${date}T${t}`)!, 60);
      const clash = entries.filter((e) => e.s < r.e && e.e > r.s);
      if (clash.some((e) => e.dentistId === dentist.id) || clash.length >= sched.capacity) continue;
      const [h, m] = t.split(':').map(Number);
      return { dentistName: dentist.name, minutes: h * 60 + m };
    }
  }
  return null;
}

/** First hour shown on the day timeline (labels are like "9 AM"). */
async function calendarViewStart(page: Page): Promise<number> {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll<HTMLElement>('span')].filter((s) => /^\d{1,2}(:\d{2})?\s?(AM|PM)$/i.test(s.textContent!.trim()) && s.style.top === '0px');
    const m = /^(\d{1,2})(?::(\d{2}))?\s?(AM|PM)$/i.exec(labels[0]?.textContent!.trim() ?? '9 AM')!;
    const h = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
    return h * 60 + Number(m[2] ?? 0);
  });
}

// ---------------- Scene 3: the patient changes their booking ----------------
async function scenePatientManages(browser: Browser, reference: string): Promise<SceneResult> {
  const ctx = await newContext(browser, 'phone');
  const startedAt = Date.now();
  const page = await ctx.newPage();
  const d = new Director(page);
  await page.goto(`${BASE}/__stage?src=${encodeURIComponent('/manage')}`);
  const app = page.frameLocator('#app');
  await app.getByLabel('Booking reference').waitFor();
  await page.evaluate(() => (window as any).__overlay.touch());
  await d.step('For patients', 'Plans change. <em>No problem.</em>', 'Patients move or cancel their own booking online, up to the day before.');
  await sleep(1000);
  const readyAt = Date.now() - 300;
  await sleep(2000);

  await d.type(app.getByLabel('Booking reference'), reference, 90);
  await d.type(app.getByLabel('Mobile number'), PATIENT.mobile, 70);
  await d.click(app.getByRole('button', { name: 'Find my booking' }));
  await app.locator('.manage-booking').waitFor();
  await d.step('For patients', 'Already <em>confirmed</em>', 'They see the latest status: date, time, dentist and reference.', 3200);

  await d.step('For patients', 'Pick a new <em>time</em>', 'Same live availability as booking. The clinic gets an alert and re-confirms.');
  await d.click(app.getByRole('button', { name: 'Change time' }));
  await sleep(800);
  const days = app.locator('.day-chip:not(.is-full):not(.day-chip-other)');
  await d.click(days.nth(3));
  await sleep(900);
  await d.click(app.locator('.time-slot').first());
  await sleep(600);
  await d.click(app.getByRole('button', { name: 'Move my appointment' }));
  await app.locator('.alert-success').waitFor();
  await d.smoothScrollTo(app.locator('.manage-booking'), 'start');
  await sleep(2800);

  await d.step('Beatifics Dental Clinic', 'Booking made <em>simple</em>', 'For patients on their phones, and for the team at the front desk.', 5000);
  return finish(ctx, page, '3-patient-manages', startedAt, readyAt);
}

export async function recordAll(outDir: string, base: string): Promise<SceneResult[]> {
  OUT = outDir;
  BASE = base;
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    console.log('Recording scene 1: patient books…');
    const s1 = await scenePatientBooks(browser);
    console.log(`  booked ${s1.reference} for ${s1.date} ${s1.time}`);
    console.log('Recording scene 2: admin portal…');
    const s2 = await sceneAdmin(browser, s1);
    console.log('Recording scene 3: patient manages…');
    const s3 = await scenePatientManages(browser, s1.reference);
    return [s1, s2, s3];
  } finally {
    await browser.close();
  }
}
