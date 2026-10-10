/**
 * Application shell: skip link, header, identity switcher, navigation, content
 * area, footer.
 *
 * ===========================================================================
 * WHAT THE SWITCHER IN THE HEADER IS, AND IS NOT
 * ===========================================================================
 *
 * It is not a sign-in and it is not an account menu. It is role simulation:
 * picking "Dr. Esther Mbeki - Supervisor" makes the NEXT request act as a
 * supervisor, because the server sets a cookie naming that profile and reads the
 * role from the profile row. Nothing is verified, because there is nothing to
 * verify - see services/identityService.ts.
 *
 * It is here for the demo: a judge can try the booking flow as a representative,
 * then switch to a student and watch the same button be refused by the SERVER,
 * then switch to the administrator. That is a stronger demonstration of the role
 * model than a login screen, because it shows the rules surviving a role change
 * mid-session.
 *
 * The banner at the bottom is not decoration either. Every facility name,
 * capacity and schedule in this application is invented sample data, and saying
 * so persistently is the difference between a demo and a misleading claim about
 * Maseno University's real timetable.
 */
import { useState, type ChangeEvent } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

import { useIdentity } from '../identity/IdentityContext'
import { ApiError } from '../lib/api'

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/facilities', label: 'Directory', end: false },
  { to: '/suggest', label: 'Suggest a room', end: false },
  { to: '/bookings', label: 'My bookings', end: false },
]

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'px-3 py-2 rounded-lg text-sm font-medium',
    isActive ? 'bg-brand-50 text-brand-700' : 'text-campus-600 hover:bg-campus-100 hover:text-campus-900',
  ].join(' ')
}

export function Layout(): JSX.Element {
  const { user, identities, switchIdentity } = useIdentity()
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

  /**
   * Switches identity, and reports a failure instead of looking like it worked.
   *
   * `switchIdentity` deliberately throws rather than swallowing (see
   * IdentityContext), so a request that failed leaves the header showing the
   * identity that is genuinely still in force.
   */
  async function handleSwitch(event: ChangeEvent<HTMLSelectElement>): Promise<void> {
    const userId = event.target.value

    setSwitching(true)
    setSwitchError(null)

    try {
      await switchIdentity(userId)
    } catch (cause) {
      setSwitchError(
        cause instanceof ApiError ? cause.message : 'Could not switch identity. Try again.',
      )
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <a
        href="#main"
        className="visually-hidden focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:bg-white focus:rounded-lg focus:shadow-raised"
      >
        Skip to content
      </a>

      <header className="bg-white border-b border-campus-200">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-6 min-w-0">
              <NavLink to="/" className="flex items-center gap-2 shrink-0">
                <span
                  className="h-8 w-8 rounded-lg bg-brand-600 text-white grid place-items-center font-semibold"
                  aria-hidden="true"
                >
                  E
                </span>
                <span className="font-semibold text-campus-900">EduVenue</span>
              </NavLink>

              <nav aria-label="Main" className="hidden sm:flex items-center gap-1">
                {NAV.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>

            {user ? (
              <div className="flex items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <label
                    htmlFor="identity-switcher"
                    className="block text-xs text-campus-500 sm:text-right"
                  >
                    Acting as
                  </label>
                  <select
                    id="identity-switcher"
                    value={user.id}
                    onChange={handleSwitch}
                    disabled={switching}
                    title="Role simulation, not sign-in. The server still enforces every rule for the identity you pick."
                    className="mt-0.5 max-w-[16rem] truncate rounded-lg border border-campus-300 bg-white px-2 py-1 text-sm text-campus-900 disabled:opacity-60"
                  >
                    {identities.map((identity) => (
                      <option key={identity.id} value={identity.id}>
                        {identity.displayName} — {identity.roleLabel}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : null}
          </div>

          {switchError ? (
            <p role="alert" className="pb-2 text-xs text-rose-700">
              {switchError}
            </p>
          ) : null}

          {/* Mobile navigation: the header nav is hidden below `sm`. */}
          <nav aria-label="Main" className="sm:hidden flex items-center gap-1 pb-3">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main id="main" className="flex-1">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-campus-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-5 space-y-2">
          <p className="text-xs text-campus-500">
            <strong className="font-medium text-campus-700">Demonstration data.</strong> Every
            facility, capacity and schedule shown here is illustrative sample data created for
            this project. It is not Maseno University's actual venue information, and this
            application is not connected to any university system.
          </p>
          <p className="text-xs text-campus-500">
            <strong className="font-medium text-campus-700">No sign-in.</strong> You are acting as
            a demo identity chosen from the header. This application does not authenticate users,
            so it must not be used with real data. The booking rules it enforces - role,
            supervision, opening hours and non-overlap - are enforced by the server regardless of
            which identity is selected.
          </p>
        </div>
      </footer>
    </div>
  )
}
