import { DEFAULT_SETTINGS, settingsSchema, type ClinicSettings } from '../shared/schedule.ts';
import type { Db } from './db.ts';

const KEYS = {
  appointmentMinutes: 'appointment_minutes',
  capacity: 'capacity',
  serviceMinutes: 'service_minutes',
} as const;

export function getSettings(db: Db): ClinicSettings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let serviceMinutes: unknown = {};
  try {
    serviceMinutes = stored[KEYS.serviceMinutes] ? JSON.parse(stored[KEYS.serviceMinutes]) : {};
  } catch {
    serviceMinutes = {};
  }
  const parsed = settingsSchema.safeParse({
    appointmentMinutes: stored[KEYS.appointmentMinutes] ? Number(stored[KEYS.appointmentMinutes]) : DEFAULT_SETTINGS.appointmentMinutes,
    capacity: stored[KEYS.capacity] ? Number(stored[KEYS.capacity]) : DEFAULT_SETTINGS.capacity,
    serviceMinutes,
  });
  // Fall back to defaults if something invalid was ever stored.
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function saveSettings(db: Db, settings: ClinicSettings): ClinicSettings {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run(KEYS.appointmentMinutes, String(settings.appointmentMinutes));
  upsert.run(KEYS.capacity, String(settings.capacity));
  upsert.run(KEYS.serviceMinutes, JSON.stringify(settings.serviceMinutes));
  return getSettings(db);
}
