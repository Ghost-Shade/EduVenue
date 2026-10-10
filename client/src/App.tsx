/**
 * Routing.
 *
 * The structure encodes the access rule in one place: `/login` is the only
 * public route, and everything else sits behind `RequireAuth`, then inside the
 * shared `Layout`. A new page cannot be added without deciding which side of
 * that line it belongs on.
 *
 * As everywhere in this client, this is a routing decision, not a security
 * boundary. The API refuses unauthenticated requests itself.
 */
import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { AuthProvider } from './auth/AuthContext'
import { Layout } from './components/Layout'
import { RequireAuth } from './components/RequireAuth'
import { BookFacilityPage } from './pages/BookFacilityPage'
import { BookingDetailPage } from './pages/BookingDetailPage'
import { DashboardPage } from './pages/DashboardPage'
import { DirectoryPage } from './pages/DirectoryPage'
import { FacilityDetailPage } from './pages/FacilityDetailPage'
import { LoginPage } from './pages/LoginPage'
import { MyBookingsPage } from './pages/MyBookingsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { SuggestPage } from './pages/SuggestPage'

export default function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="facilities" element={<DirectoryPage />} />
              <Route path="facilities/:id" element={<FacilityDetailPage />} />
              <Route path="facilities/:id/book" element={<BookFacilityPage />} />
              <Route path="suggest" element={<SuggestPage />} />
              <Route path="bookings" element={<MyBookingsPage />} />
              <Route path="bookings/:id" element={<BookingDetailPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
