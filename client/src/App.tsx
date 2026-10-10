/**
 * Routing.
 *
 * There is no `/login` route any more, and that is the visible half of removing
 * authentication: the application opens straight into the dashboard as a class
 * representative, with the identity switcher in the header. See
 * identity/IdentityContext.tsx and services/identityService.ts.
 *
 * `IdentityGate` holds the interface back until the server has said WHO is
 * acting, then renders the shared `Layout`. So the structure still encodes one
 * decision in one place: a new page cannot be added without passing through the
 * layout, and every page is therefore written on the assumption that an identity
 * exists. That assumption is now true - the server always has one to report -
 * which is why the pages below no longer need a sign-in fallback.
 *
 * As everywhere in this client, this is a routing decision, not a security
 * boundary. The API enforces the role rules itself.
 */
import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { Layout } from './components/Layout'
import { IdentityGate } from './components/IdentityGate'
import { IdentityProvider } from './identity/IdentityContext'
import { BookFacilityPage } from './pages/BookFacilityPage'
import { BookingDetailPage } from './pages/BookingDetailPage'
import { DashboardPage } from './pages/DashboardPage'
import { DirectoryPage } from './pages/DirectoryPage'
import { FacilityDetailPage } from './pages/FacilityDetailPage'
import { MyBookingsPage } from './pages/MyBookingsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { SuggestPage } from './pages/SuggestPage'

export default function App(): JSX.Element {
  return (
    <BrowserRouter>
      <IdentityProvider>
        <Routes>
          <Route element={<IdentityGate />}>
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
      </IdentityProvider>
    </BrowserRouter>
  )
}
