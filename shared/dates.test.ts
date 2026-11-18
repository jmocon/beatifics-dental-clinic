import { describe, expect, it } from 'vitest';
import {
  bookingWindow,
  isBookableDate,
  isClinicDay,
  isDateString,
  isWithinClinicHours,
  manilaLocalToUtcIso,
  manilaToday,
  relativeDay,
  upcomingClinicDays,
  utcIsoToManilaLocal,
} from './dates.ts';

// Tuesday 6 Oct 2026, 10:00 AM in Manila
const NOW = new Date('2026-10-06T02:00:00Z');

describe('manila dates', () => {
  it('uses Manila time, not UTC, for "today"', () => {
    // 11:30 PM UTC on the 5th is already 7:30 AM on the 6th in Manila
    expect(manilaToday(new Date('2026-10-05T23:30:00Z'))).toBe('2026-10-06');
    expect(manilaToday(new Date('2026-10-05T15:59:00Z'))).toBe('2026-10-05');
    expect(manilaToday(new Date('2026-10-05T16:00:00Z'))).toBe('2026-10-06');
  });

  it('validates real calendar dates', () => {
    expect(isDateString('2026-02-28')).toBe(true);
    expect(isDateString('2026-02-30')).toBe(false);
    expect(isDateString('2026-2-3')).toBe(false);
    expect(isDateString('nope')).toBe(false);
  });

  it('knows the clinic is closed on Friday and Sunday', () => {
    expect(isClinicDay('2026-10-05')).toBe(true); // Mon
    expect(isClinicDay('2026-10-09')).toBe(false); // Fri
    expect(isClinicDay('2026-10-10')).toBe(true); // Sat
    expect(isClinicDay('2026-10-11')).toBe(false); // Sun
  });

  it('opens the booking window from tomorrow for 60 days', () => {
    expect(bookingWindow(NOW)).toEqual({ first: '2026-10-07', last: '2026-12-05' });
    expect(isBookableDate('2026-10-06', NOW)).toBe(false); // today
    expect(isBookableDate('2026-10-07', NOW)).toBe(true);
    expect(isBookableDate('2026-10-09', NOW)).toBe(false); // Friday
    expect(isBookableDate('2026-12-07', NOW)).toBe(false); // too far
    expect(isBookableDate('2026-10-01', NOW)).toBe(false); // past
  });

  it('lists upcoming clinic days, skipping closed days', () => {
    expect(upcomingClinicDays(5, NOW)).toEqual(['2026-10-07', '2026-10-08', '2026-10-10', '2026-10-12', '2026-10-13']);
  });

  it('converts Manila local time to UTC and back', () => {
    expect(manilaLocalToUtcIso('2026-10-07T09:00')).toBe('2026-10-07T01:00:00.000Z');
    expect(manilaLocalToUtcIso('2026-10-07T07:30')).toBe('2026-10-06T23:30:00.000Z');
    expect(utcIsoToManilaLocal('2026-10-06T23:30:00.000Z')).toBe('2026-10-07T07:30');
    expect(manilaLocalToUtcIso('2026-13-01T09:00')).toBeNull();
    expect(manilaLocalToUtcIso('2026-10-07T25:00')).toBeNull();
    expect(manilaLocalToUtcIso('garbage')).toBeNull();
  });

  it('checks clinic opening hours', () => {
    expect(isWithinClinicHours('2026-10-07T09:00')).toBe(true);
    expect(isWithinClinicHours('2026-10-07T16:45')).toBe(true);
    expect(isWithinClinicHours('2026-10-07T17:00')).toBe(false);
    expect(isWithinClinicHours('2026-10-07T08:59')).toBe(false);
    expect(isWithinClinicHours('2026-10-09T10:00')).toBe(false); // Friday
  });

  it('describes relative days', () => {
    expect(relativeDay('2026-10-06', NOW)).toBe('Today');
    expect(relativeDay('2026-10-07', NOW)).toBe('Tomorrow');
    expect(relativeDay('2026-10-10', NOW)).toBe('In 4 days');
    expect(relativeDay('2026-10-04', NOW)).toBe('2 days ago');
  });
});
