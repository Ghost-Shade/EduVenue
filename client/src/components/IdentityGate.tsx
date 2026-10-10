/**
 * Waits for the server to say who we are acting as, then renders the page.
 *
 * This replaced `RequireAuth`, and the difference is the whole point of the
 * change: there is no longer a page to be redirected TO. Nobody is signed out,
 * because nobody signs in. So this gate does not send anyone anywhere; it only
 * holds the interface back until the server has answered, and says so plainly
 * when it has not.
 *
 * It is a USABILITY gate, not a security control, and never was one: the API
 * enforces every rule itself, whether or not this component renders. What it
 * prevents is a page firing off requests and rendering controls for a role the
 * server has not confirmed - which, after an identity switch, would briefly show
 * the previous identity's permissions.
 */
import { Outlet } from 'react-router-dom'

import { useIdentity } from '../identity/IdentityContext'
import { ApiError } from '../lib/api'
import { ErrorBanner, Loading } from './ui'

export function IdentityGate(): JSX.Element {
  const { user, status, error, reload } = useIdentity()

  if (status === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loading label="Checking who you are acting as…" />
      </div>
    )
  }

  // Only reachable when the API could not be reached at all. Shown instead of a
  // guessed identity, so nobody fills in a booking form against a server that is
  // not listening.
  if (!user) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="w-full max-w-lg">
          <ErrorBanner
            error={
              error ??
              new ApiError(
                0,
                'NETWORK_ERROR',
                'Could not reach the server. Check that the API is running, then try again.',
                undefined,
              )
            }
            title="The server could not be reached"
            onRetry={reload}
          />
          <p className="mt-3 text-sm text-campus-600">
            Start the API with <code className="font-mono">npm run dev</code>, then try again.
          </p>
        </div>
      </div>
    )
  }

  // Keyed by identity so that switching remounts every page. Without this, a
  // page that had already loaded "my bookings" would keep showing the previous
  // identity's rows until it happened to refetch - the most confusing possible
  // outcome of a switcher.
  return <Outlet key={user.id} />
}
