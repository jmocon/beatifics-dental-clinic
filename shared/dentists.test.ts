import { describe, expect, it } from 'vitest';
import { chooseDentist, describeWorkingDays, freeDentists, type DaySlotContext } from './dentists.ts';
import { slotRange } from './schedule.ts';

const FRI = '2026-10-09';
const r = (time: string, mins = 60) => slotRange(FRI, time, mins);
const A = { id: 1, workingDays: [1, 2, 4, 5, 6], active: true };
const B = { id: 2, workingDays: [5, 6], active: true };

const ctx = (over: Partial<DaySlotContext> = {}): DaySlotContext => ({
  date: FRI,
  dentists: [A, B],
  closures: [],
  bookings: [],
  capacity: 2,
  ...over,
});

describe('freeDentists', () => {
  it('lists dentists who work that day and are free', () => {
    expect(freeDentists(ctx(), r('09:00'))).toEqual([1, 2]);
    expect(freeDentists(ctx({ dentists: [A, { ...B, workingDays: [6] }] }), r('09:00'))).toEqual([1]);
    expect(freeDentists(ctx({ dentists: [A, { ...B, active: false }] }), r('09:00'))).toEqual([1]);
  });

  it('a dentist sees one patient at a time', () => {
    const c = ctx({ bookings: [{ dentistId: 1, range: r('09:00') }] });
    expect(freeDentists(c, r('09:30'))).toEqual([2]);
    expect(freeDentists(c, r('10:00'))).toEqual([1, 2]);
  });

  it('respects the clinic chair limit even when dentists are free', () => {
    const c = ctx({ capacity: 1, bookings: [{ dentistId: 1, range: r('09:00') }] });
    expect(freeDentists(c, r('09:00'))).toEqual([]);
  });

  it('counts unassigned bookings against chairs, not against a dentist', () => {
    const c = ctx({ bookings: [{ dentistId: null, range: r('09:00') }] });
    expect(freeDentists(c, r('09:00'))).toEqual([1, 2]);
    const full = ctx({ bookings: [{ dentistId: null, range: r('09:00') }, { dentistId: null, range: r('09:00') }] });
    expect(freeDentists(full, r('09:00'))).toEqual([]);
  });

  it('applies clinic-wide and per-dentist blocked times', () => {
    const lunch = { id: 1, startDate: FRI, endDate: null, repeat: 'none' as const, startTime: '12:00', endTime: '13:00', reason: '' };
    expect(freeDentists(ctx({ closures: [{ ...lunch, dentistId: null }] }), r('12:00'))).toEqual([]);
    expect(freeDentists(ctx({ closures: [{ ...lunch, dentistId: 2 }] }), r('12:00'))).toEqual([1]);
    expect(freeDentists(ctx({ closures: [{ ...lunch, dentistId: 2 }] }), r('12:00'), 2)).toEqual([]);
  });
});

describe('chooseDentist', () => {
  it('prefers the regular dentist, else the least busy, else the first', () => {
    expect(chooseDentist([1, 2], 2, [], [1, 2])).toBe(2);
    expect(chooseDentist([1, 2], 3, [{ dentistId: 1 }], [1, 2])).toBe(2);
    expect(chooseDentist([1, 2], null, [], [1, 2])).toBe(1);
    expect(chooseDentist([], 1, [], [1, 2])).toBeNull();
  });
});

describe('describeWorkingDays', () => {
  it('summarises runs of days', () => {
    expect(describeWorkingDays([1, 2, 3, 4, 6])).toBe('Mon–Thu, Sat');
    expect(describeWorkingDays([2, 4, 6])).toBe('Tue, Thu, Sat');
    expect(describeWorkingDays([6, 0])).toBe('Sat, Sun');
  });
});
