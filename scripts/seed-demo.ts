// Development only: demo logins, dentists and sample bookings so the admin portal has data.
// Usage: npm run seed:demo
import { createUser } from '../server/auth.ts';
import { createBooking, updateBooking, type SlotEnv } from '../server/bookings.ts';
import { defaultDbPath, openDb } from '../server/db.ts';
import { activeDentists, createDentist, listDentists } from '../server/dentists.ts';
import { getSettings } from '../server/settings.ts';
import { SERVICES, type BookingRequest } from '../shared/booking.ts';
import { upcomingClinicDays } from '../shared/dates.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const db = openDb(defaultDbPath());
const now = new Date();
const PASSWORD = 'beatifics-demo';

async function ensureUser(email: string, name: string, role: 'admin' | 'staff') {
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  return row?.id ?? (await createUser(db, email, name, PASSWORD, role)).id;
}

await ensureUser('admin@beatifics.local', 'Clinic Staff', 'admin');
await ensureUser('reception@beatifics.local', 'Reception', 'staff');
const drUserId = await ensureUser('dentist@beatifics.local', 'Dr. Rebecca Vivo', 'staff');

if (listDentists(db).length === 0) {
  createDentist(db, { name: 'Dr. Rebecca Vivo', workingDays: [1, 2, 4, 5, 6], userId: drUserId }, now);
  createDentist(db, { name: 'Dr. Marco Reyes', workingDays: [2, 4, 6], userId: null }, now);
}

const env: SlotEnv = { settings: getSettings(db), closures: [], dentists: activeDentists(db) };
const days = upcomingClinicDays(10, now);
const people: Array<Omit<BookingRequest, 'consent'>> = [
  { fullName: 'Maria Santos', mobile: '09171234567', service: SERVICES[1], preferredDate: days[0], preferredTime: '09:00', notes: '', dentistId: null },
  { fullName: 'Jose Reyes', mobile: '09281112233', service: SERVICES[7], preferredDate: days[0], preferredTime: '09:30', notes: 'Lower left molar has been aching for 3 days.', dentistId: null },
  { fullName: 'Ana Dela Cruz', mobile: '09175556677', service: SERVICES[6], preferredDate: days[1], preferredTime: '14:00', notes: 'For my 6-year-old, first dental visit. She is a bit nervous.', dentistId: null },
  { fullName: 'Ramon Bautista', mobile: '09998887766', service: SERVICES[5], preferredDate: days[2], preferredTime: '14:00', notes: 'Asking about braces options and cost.', dentistId: null },
  { fullName: 'Liza Mendoza', mobile: '09223334455', service: SERVICES[2], preferredDate: days[3], preferredTime: '10:30', notes: '', dentistId: null },
  { fullName: 'Paolo Garcia', mobile: '09164443322', service: SERVICES[0], preferredDate: days[4], preferredTime: '11:00', notes: '', dentistId: null },
];

let added = 0;
for (const [i, p] of people.entries()) {
  const result = createBooking(db, { ...p, consent: true }, env, new Date(now.getTime() - (i + 1) * 47 * 60_000));
  if ('slotTaken' in result || result.duplicate) continue;
  added++;
  // Confirm a couple so the "Upcoming" view has data; one gets a longer slot.
  if (i === 3 || i === 4) {
    updateBooking(
      db,
      result.booking,
      { status: 'confirmed', durationMinutes: i === 3 ? 90 : undefined, staffNotes: 'Confirmed by phone.' },
      'Clinic Staff',
      now,
    );
  }
}

console.log(`Seeded ${added} demo bookings (skipped any that already existed or clashed).`);
console.log(`Demo logins (password ${PASSWORD}):`);
console.log('  admin@beatifics.local (admin) · reception@beatifics.local (staff) · dentist@beatifics.local (Dr. Vivo, staff)');
