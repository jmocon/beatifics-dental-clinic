// Extra demo data for the showcase video: ~3 months of history (so Reports has something to show),
// a busier calendar for the next few days and a daily lunch break. Run after seed-demo.ts, on a fresh DB.
import { createStaffBooking, updateBooking } from '../../server/bookings.ts';
import { createClosure } from '../../server/closures.ts';
import { defaultDbPath, openDb } from '../../server/db.ts';
import { listDentists } from '../../server/dentists.ts';
import { SERVICES, type Service } from '../../shared/booking.ts';
import { addDays, isClinicDay, manilaLocalToUtcIso, manilaToday, upcomingClinicDays, weekdayOf } from '../../shared/dates.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const db = openDb(defaultDbPath());
const now = new Date();
const today = manilaToday(now);
const dentists = listDentists(db);
const vivo = dentists.find((d) => d.name.includes('Vivo'))!;
const marco = dentists.find((d) => d.name.includes('Marco'))!;

const NAMES = [
  'Carmela Aquino', 'Rafael Domingo', 'Bea Lim', 'Noel Castillo', 'Joanna Navarro', 'Miguel Tan', 'Patricia Ramos',
  'Enzo Villareal', 'Kristine Flores', 'Daniel Ocampo', 'Sofia Gonzales', 'Mark Pascual', 'Angela Cruz', 'Luis Mercado',
  'Trisha Valdez', 'Carlo Santiago', 'Nicole Torres', 'Andre Salazar', 'Hannah Robles', 'Jerome Medina',
];
const TIMES = ['09:00', '10:00', '11:00', '13:30', '14:30', '15:30'];
const SERVICE_MIX: Service[] = [SERVICES[1], SERVICES[1], SERVICES[2], SERVICES[0], SERVICES[1], SERVICES[3], SERVICES[6], SERVICES[4], SERVICES[2], SERVICES[5]];

// Small deterministic PRNG so every recording gets the same-looking data.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const mobileFor = (i: number) => `09${String(170000000 + i * 7919).padStart(9, '0')}`;

function add(opts: {
  name: string;
  mobile: string;
  service: Service;
  date: string;
  time: string;
  minutes?: number;
  dentistId: number | null;
  status: 'confirmed' | 'completed' | 'no_show' | 'cancelled' | 'pending';
  online?: boolean;
  createdDaysBefore?: number;
}) {
  const created = new Date(new Date(manilaLocalToUtcIso(`${opts.date}T${opts.time}`)!).getTime() - (opts.createdDaysBefore ?? 5) * 86_400_000);
  const b = createStaffBooking(
    db,
    {
      fullName: opts.name,
      mobile: opts.mobile,
      service: opts.service,
      startAt: `${opts.date}T${opts.time}`,
      durationMinutes: opts.minutes ?? 60,
      dentistId: opts.dentistId,
      status: opts.status === 'pending' ? 'pending' : 'confirmed',
      staffNotes: '',
    },
    'Reception',
    created < now ? created : now,
  );
  if (opts.status !== 'confirmed' && opts.status !== 'pending') updateBooking(db, b, { status: opts.status }, 'Reception', now);
  if (opts.online) db.prepare("UPDATE bookings SET source = 'online', updated_by = NULL WHERE id = ?").run(b.id);
  return b;
}

// ---- History: the last ~90 days ----
let n = 0;
for (let d = addDays(today, -90); d < today; d = addDays(d, 1)) {
  if (!isClinicDay(d)) continue;
  const count = 1 + Math.floor(rand() * 3);
  const times = [...TIMES].sort(() => rand() - 0.5).slice(0, count);
  for (const time of times) {
    const i = n++;
    const dentist = marco.workingDays.includes(weekdayOf(d)) && rand() < 0.45 ? marco : vivo;
    const r = rand();
    add({
      name: NAMES[i % NAMES.length],
      mobile: mobileFor(i % NAMES.length),
      service: pick(SERVICE_MIX),
      date: d,
      time,
      dentistId: dentist.id,
      status: r < 0.08 ? 'no_show' : r < 0.16 ? 'cancelled' : 'completed',
      online: rand() < 0.65,
      createdDaysBefore: 2 + Math.floor(rand() * 8),
    });
  }
}

// Maria Santos (from seed-demo) is a regular of Dr. Vivo: staff type her number and the name fills in.
for (const back of [70, 25]) {
  let d = addDays(today, -back);
  while (!isClinicDay(d) || !vivo.workingDays.includes(weekdayOf(d))) d = addDays(d, -1);
  add({ name: 'Maria Santos', mobile: '09171234567', service: SERVICES[1], date: d, time: '16:00', dentistId: vivo.id, status: 'completed', online: true });
}

// ---- The next few clinic days: confirmed appointments so the calendar looks like a real week ----
const upcoming = upcomingClinicDays(6, now);
const plan: Array<[number, string, number, Service, number?]> = [
  // [day index, time, dentist id, service, minutes]
  [0, '10:30', marco.id, SERVICES[4], 90],
  [0, '13:00', vivo.id, SERVICES[2]],
  [0, '15:00', marco.id, SERVICES[1]],
  [1, '10:30', vivo.id, SERVICES[2]],
  [1, '13:00', marco.id, SERVICES[3], 120],
  [2, '09:00', vivo.id, SERVICES[1]],
  [2, '11:00', marco.id, SERVICES[5]],
  [2, '15:00', vivo.id, SERVICES[0]],
  [3, '13:00', vivo.id, SERVICES[2]],
  [4, '09:30', vivo.id, SERVICES[1]],
  [4, '14:00', marco.id, SERVICES[3], 120],
  [5, '10:00', vivo.id, SERVICES[6]],
];
let u = 0;
for (const [dayIdx, time, dentistId, service, minutes] of plan) {
  const date = upcoming[dayIdx];
  const dentist = dentists.find((d) => d.id === dentistId)!;
  if (!date || !dentist.workingDays.includes(weekdayOf(date))) continue;
  add({ name: NAMES[(u * 3 + 1) % NAMES.length], mobile: mobileFor((u * 3 + 1) % NAMES.length), service, date, time, minutes, dentistId, status: 'confirmed', online: u % 2 === 0, createdDaysBefore: 3 });
  u++;
}

// Daily lunch break, shown hatched on the calendar.
createClosure(
  db,
  { startDate: today, endDate: null, repeat: 'daily', startTime: '12:00', endTime: '13:00', reason: 'Lunch break', dentistId: null },
  'Clinic Staff',
  now,
);

console.log(`Video seed: ${n + 2} past bookings, ${u} upcoming confirmed, lunch break added.`);
