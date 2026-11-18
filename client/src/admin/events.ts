import { useEffect, useRef } from 'react';

const EVENT = 'bd:bookings-changed';

/** Tell every open admin view (list, calendar, detail) that bookings changed. */
export function emitBookingsChanged() {
  window.dispatchEvent(new Event(EVENT));
}

export function useOnBookingsChanged(callback: () => void) {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
}

/** Context passed to side panels (booking detail, new appointment, block time) from the list or calendar. */
export interface PanelContext {
  /** Reload the host view after a change. */
  refresh: () => void;
  /** Where "← back" goes on small screens. */
  backTo: string;
  /** Link to a booking inside the same host view. */
  detailHref: (id: number) => string;
  /** The next pending request after this one, for "Next request →". */
  nextPendingId?: (afterId: number) => number | null;
  /** Calendar only: link to block a time instead of booking it. */
  blockHref?: (date: string, time: string, dentistId?: number | null) => string;
}

/** True when the user is typing, so single-key shortcuts must not fire. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}
