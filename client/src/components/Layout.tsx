/**
 * Application shell: skip link, header, navigation, content area, footer.
 *
 * The banner at the bottom is not decoration. Every facility name, capacity and
 * schedule in this application is invented sample data, and saying so
 * persistently is the difference between a demo and a misleading claim about
 * Maseno University's real timetable.
 */
import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { buttonSecondary } from './ui'

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
  const { user, signOut } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut(): Promise<void> {
    await signOut()
    navigate('/login', { replace: true })
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

            <div className="flex items-center gap-3 min-w-0">
              {user ? (
                <>
                  <div className="text-right hidden sm:block min-w-0">
                    <p className="text-sm font-medium text-campus-900 truncate">{user.displayName}</p>
                    <p className="text-xs text-campus-500">{user.roleLabel}</p>
                  </div>
                  <button type="button" onClick={handleSignOut} className={buttonSecondary}>
                    Sign out
                  </button>
                </>
              ) : null}
            </div>
          </div>

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
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-5">
          <p className="text-xs text-campus-500">
            <strong className="font-medium text-campus-700">Demonstration data.</strong> Every
            facility, capacity and schedule shown here is illustrative sample data created for
            this project. It is not Maseno University's actual venue information, and this
            application is not connected to any university system.
          </p>
        </div>
      </footer>
    </div>
  )
}
