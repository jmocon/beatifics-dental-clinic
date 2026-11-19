import { describe, expect, it } from 'vitest';
import {
  closureAppliesOn,
  closureSchema,
  dailySlots,
  describeClosure,
  durationFor,
  fits,
  formatDuration,
  formatTime,
  layoutLanes,
  maxOverlap,
  settingsSchema,
  slotRange,
} from './schedule.ts';

describe('closures', () => {
  it('applies once, over a range, daily, or weekly', () => {
    const once = { startDate: '2026-10-07', endDate: null, repeat: 'none' as const };
    expect(closureAppliesOn(once, '2026-10-07')).toBe(true);
    expect(closureAppliesOn(once, '2026-10-08')).toBe(false);

    const range = { startDate: '2026-10-07', endDate: '2026-10-10', repeat: 'none' as const };
    expect(closureAppliesOn(range, '2026-10-09')).toBe(true);
    expect(closureAppliesOn(range, '2026-10-11')).toBe(false);

    const daily = { startDate: '2026-10-07', endDate: '2026-10-31', repeat: 'daily' as const };
    expect(closureAppliesOn(daily, '2026-10-06')).toBe(false);
    expect(closureAppliesOn(daily, '2026-10-20')).toBe(true);
    expect(closureAppliesOn(daily, '2026-11-01')).toBe(false);

    const weekly = { startDate: '2026-10-07', endDate: null, repeat: 'weekly' as const }; // Wednesdays
    expect(closureAppliesOn(weekly, '2026-10-14')).toBe(true);
    expect(closureAppliesOn(weekly, '2026-10-15')).toBe(false);
  });

  it('describes closures for people', () => {
    expect(describeClosure({ startDate: '2026-10-07', endDate: null, repeat: 'daily', startTime: '12:00', endTime: '13:00' })).toEqual({
      when: 'Every day from Wed, Oct 7',
      time: '12:00 PM – 1:00 PM',
    });
    expect(describeClosure({ startDate: '2026-12-24', endDate: '2026-12-26', repeat: 'none', startTime: null, endTime: null }).time).toBe(
      'All day',
    );
  });

  it('validates input', () => {
    expect(closureSchema.safeParse({ startDate: '2026-10-09' }).success).toBe(true);
    expect(closureSchema.safeParse({ startDate: '2026-10-09', startTime: '13:00', endTime: '12:00' }).success).toBe(false);
  });
});

describe('durationFor', () => {
  it('uses a service length when set, otherwise the default', () => {
    const s = { appointmentMinutes: 60, capacity: 2, serviceMinutes: { 'Root Canal Treatment': 120 } };
    expect(durationFor(s, 'Root Canal Treatment')).toBe(120);
    expect(durationFor(s, 'Check-ups & Cleaning')).toBe(60);
  });
});

describe('layoutLanes', () => {
  it('puts overlapping appointments side by side and reuses free lanes', () => {
    const out = layoutLanes([
      { id: 'a', start: 540, end: 600 },
      { id: 'b', start: 540, end: 600 },
      { id: 'c', start: 600, end: 660 }, // starts as a/b end: new group, one lane
      { id: 'd', start: 660, end: 720 },
      { id: 'e', start: 690, end: 750 }, // overlaps d
    ]);
    const by = Object.fromEntries(out.map((o) => [o.id, [o.lane, o.lanes]]));
    expect(by).toEqual({ a: [0, 2], b: [1, 2], c: [0, 1], d: [0, 2], e: [1, 2] });
  });
});

describe('dailySlots', () => {
  it('offers a start every 30 minutes that ends by closing time', () => {
    const slots = dailySlots('2026-10-09', 60); // Friday
    expect(slots[0]).toBe('09:00');
    expect(slots.at(-1)).toBe('16:00');
    expect(slots).toHaveLength(15);
  });

  it('fits fewer starts for longer appointments', () => {
    expect(dailySlots('2026-10-09', 120).at(-1)).toBe('15:00');
    expect(dailySlots('2026-10-09', 30).at(-1)).toBe('16:30');
  });

  it('has no slots on closed days', () => {
    expect(dailySlots('2026-10-07', 60)).toEqual([]); // Wednesday
    expect(dailySlots('2026-10-11', 60)).toEqual([]); // Sunday
  });
});

describe('capacity', () => {
  const d = '2026-10-09';
  const r = (time: string, mins = 60) => slotRange(d, time, mins);

  it('counts the most appointments running at once', () => {
    const existing = [r('09:00'), r('09:30'), r('11:00')];
    expect(maxOverlap(r('09:00'), existing)).toBe(2);
    expect(maxOverlap(r('10:00'), existing)).toBe(1); // only 9:30–10:30 overlaps
    expect(maxOverlap(r('12:00'), existing)).toBe(0);
  });

  it('treats back-to-back appointments as not overlapping', () => {
    expect(maxOverlap(r('10:00'), [r('09:00')])).toBe(0);
    expect(maxOverlap(r('09:00'), [r('10:00')])).toBe(0);
  });

  it('does not double count appointments that never overlap each other', () => {
    // A 2-hour slot touched by two separate 1-hour appointments still only has 1 at a time.
    expect(maxOverlap(r('09:00', 120), [r('09:00'), r('10:00')])).toBe(1);
  });

  it('decides whether one more patient fits', () => {
    const existing = [r('09:00'), r('09:30')];
    expect(fits(r('09:00'), existing, 2)).toBe(false);
    expect(fits(r('09:00'), existing, 3)).toBe(true);
    expect(fits(r('10:30'), existing, 1)).toBe(true);
  });
});

describe('formatting', () => {
  it('formats times and durations for people', () => {
    expect(formatTime('09:00')).toBe('9:00 AM');
    expect(formatTime('12:30')).toBe('12:30 PM');
    expect(formatTime('16:00')).toBe('4:00 PM');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(120)).toBe('2 hours');
  });
});

describe('settingsSchema', () => {
  it('accepts sensible values and rejects odd ones', () => {
    expect(settingsSchema.safeParse({ appointmentMinutes: 60, capacity: 2 }).success).toBe(true);
    expect(settingsSchema.safeParse({ appointmentMinutes: 50, capacity: 2 }).success).toBe(false); // not 15-min step
    expect(settingsSchema.safeParse({ appointmentMinutes: 0, capacity: 2 }).success).toBe(false);
    expect(settingsSchema.safeParse({ appointmentMinutes: 60, capacity: 0 }).success).toBe(false);
    expect(settingsSchema.safeParse({ appointmentMinutes: 60, capacity: 1.5 }).success).toBe(false);
  });
});
