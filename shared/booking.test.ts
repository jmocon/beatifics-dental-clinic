import { describe, expect, it } from 'vitest';
import { bookingRequestSchema, canTransition, formatPhMobile, normalizePhMobile, zodFieldErrors } from './booking.ts';

const NOW = new Date('2026-10-06T02:00:00Z'); // Tue 6 Oct, 10 AM Manila

const valid = {
  fullName: 'Maria Santos',
  mobile: '0917 123 4567',
  service: 'Check-ups & Cleaning',
  preferredDate: '2026-10-09',
  preferredTime: '09:00',
  notes: '',
  consent: true,
};

describe('normalizePhMobile', () => {
  it.each([
    ['09171234567', '09171234567'],
    ['0917 123 4567', '09171234567'],
    ['0917-123-4567', '09171234567'],
    ['+63 917 123 4567', '09171234567'],
    ['639171234567', '09171234567'],
    ['(0917) 123.4567', '09171234567'],
  ])('accepts %s', (input, expected) => {
    expect(normalizePhMobile(input)).toBe(expected);
  });

  it.each(['', '0917123456', '091712345678', '08171234567', '+1 415 555 0100', '(02) 8775 9896', 'abc'])('rejects %s', (input) => {
    expect(normalizePhMobile(input)).toBeNull();
  });

  it('formats for display', () => {
    expect(formatPhMobile('09171234567')).toBe('0917 123 4567');
  });
});

describe('bookingRequestSchema', () => {
  const schema = bookingRequestSchema(NOW);

  it('accepts a valid request and normalises it', () => {
    const r = schema.parse({ ...valid, fullName: '  Maria Santos  ', notes: '  hi ' });
    expect(r).toMatchObject({ fullName: 'Maria Santos', mobile: '09171234567', notes: 'hi', consent: true });
  });

  it('defaults optional notes', () => {
    const { notes: _n, ...rest } = valid;
    expect(schema.parse(rest).notes).toBe('');
  });

  it('requires a valid time', () => {
    for (const t of ['', '9:00', '25:00', 'noon']) {
      expect(schema.safeParse({ ...valid, preferredTime: t }).success, t).toBe(false);
    }
  });

  it('reports a friendly message for each problem field', () => {
    const r = schema.safeParse({ fullName: 'A', mobile: '123', service: 'Teeth whitening', preferredDate: '2026-10-07', consent: false });
    expect(r.success).toBe(false);
    const fields = zodFieldErrors(r.error!);
    expect(Object.keys(fields).sort()).toEqual(['consent', 'fullName', 'mobile', 'preferredDate', 'preferredTime', 'service']);
    expect(fields.mobile).toMatch(/PH mobile/);
  });

  it('rejects closed days, today and past dates', () => {
    for (const d of ['2026-10-07', '2026-10-11', '2026-10-06', '2026-10-02', '2026-12-30']) {
      expect(schema.safeParse({ ...valid, preferredDate: d }).success, d).toBe(false);
    }
  });

  it('rejects overlong notes and names', () => {
    expect(schema.safeParse({ ...valid, notes: 'x'.repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ ...valid, fullName: 'x'.repeat(101) }).success).toBe(false);
  });

  it('requires explicit consent', () => {
    expect(schema.safeParse({ ...valid, consent: 'yes' }).success).toBe(false);
    const { consent: _c, ...noConsent } = valid;
    expect(schema.safeParse(noConsent).success).toBe(false);
  });
});

describe('canTransition', () => {
  it('follows the booking lifecycle', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true);
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('confirmed', 'completed')).toBe(true);
    expect(canTransition('confirmed', 'no_show')).toBe(true);
    expect(canTransition('confirmed', 'pending')).toBe(false);
    expect(canTransition('cancelled', 'pending')).toBe(true);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
    expect(canTransition('completed', 'pending')).toBe(false);
    expect(canTransition('no_show', 'completed')).toBe(false);
    expect(canTransition('completed', 'completed')).toBe(true);
  });
});
