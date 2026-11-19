import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Tests use fixed dates around Tue 6 Oct 2026 and pass that "now" into the app. Pin the global clock
// to the same day so anything that reads the real clock (e.g. Supertest's cookie jar dropping
// session cookies whose 7-day expiry is in the real past) agrees with it. Only Date is faked;
// timers still run normally.
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-10-06T02:00:00Z'));
