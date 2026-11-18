// Base styles must load before any page styles so page rules can override them.
import './styles/base.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ManagePage } from './site/ManagePage.tsx';
import { PrivacyPage } from './site/PrivacyPage.tsx';
import { SitePage } from './site/SitePage.tsx';

const AdminApp = lazy(() => import('./admin/AdminApp.tsx'));

const adminFallback = (
  <div className="admin-loading" role="status">
    <span className="spinner" aria-hidden="true" />
    Loading…
  </div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SitePage />} />
        <Route path="/manage" element={<ManagePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={adminFallback}>
              <AdminApp />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
