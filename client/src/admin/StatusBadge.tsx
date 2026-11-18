import { STATUS_LABELS, type BookingStatus } from '../../../shared/booking.ts';

export function StatusBadge({ status }: { status: BookingStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}
