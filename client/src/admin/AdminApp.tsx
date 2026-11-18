import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminLayout } from './AdminLayout.tsx';
import { AuthProvider, RequireStaff, useAuth } from './auth.tsx';
import { BlockTimeForm } from './BlockTimeForm.tsx';
import { BookingDetail, NoBookingSelected } from './BookingDetail.tsx';
import { BookingsPage } from './BookingsPage.tsx';
import { CalendarDaySummary, CalendarPage } from './CalendarPage.tsx';
import { LoginPage } from './LoginPage.tsx';
import { NewBookingForm } from './NewBookingForm.tsx';
import { ReportsPage } from './ReportsPage.tsx';
import {
  AccountSettings,
  ActivitySettings,
  BlockedTimesSettings,
  DentistsSettings,
  GeneralSettings,
  SettingsLayout,
  StaffSettings,
} from './SettingsPage.tsx';

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/admin/settings" replace />;
}

/** Everything under /admin. Loaded lazily so patients never download admin code. */
export default function AdminApp() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          element={
            <RequireStaff>
              <AdminLayout />
            </RequireStaff>
          }
        >
          <Route element={<BookingsPage />}>
            <Route index element={<NoBookingSelected />} />
            <Route path="bookings/new" element={<NewBookingForm />} />
            <Route path="bookings/:id" element={<BookingDetail />} />
          </Route>
          <Route path="calendar" element={<CalendarPage />}>
            <Route index element={<CalendarDaySummary />} />
            <Route path="new" element={<NewBookingForm />} />
            <Route path="block" element={<BlockTimeForm />} />
            <Route path=":id" element={<BookingDetail />} />
          </Route>
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<GeneralSettings />} />
            <Route path="dentists" element={<DentistsSettings />} />
            <Route path="blocked" element={<BlockedTimesSettings />} />
            <Route
              path="staff"
              element={
                <AdminOnly>
                  <StaffSettings />
                </AdminOnly>
              }
            />
            <Route
              path="activity"
              element={
                <AdminOnly>
                  <ActivitySettings />
                </AdminOnly>
              }
            />
            <Route path="account" element={<AccountSettings />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}
