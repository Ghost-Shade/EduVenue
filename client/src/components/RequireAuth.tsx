/**
 * Route guard.
 *
 * This hides pages from signed-out users, which is a usability matter. It is
 * NOT a security control: the API independently refuses every request that
 * needs a session, and that refusal is what protects the data. Anyone can send
 * the request without ever loading this component.
 *
 * It also records where the user was heading, so signing in returns them there
 * rather than dumping them on the dashboard.
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { Loading } from './ui'

export function RequireAuth(): JSX.Element {
  const { user, status } = useAuth()
  const location = useLocation()

  // Waiting for the session to resolve is not the same as being signed out.
  // Redirecting here would bounce a signed-in user refreshing the page.
  if (status === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loading label="Checking your session…" />
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return <Outlet />
}
