/**
 * Dashboard: the one screen that answers "what do I need to do next".
 *
 * Deliberately ordered by urgency - what is coming up, then what can be done
 * about it - rather than presenting every feature at once.
 */
import { Link } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { describeDay, formatTimeRange, isToday } from '../lib/time'
import { useResource } from '../hooks/useResource'
import { BookingStatusBadge, ErrorBanner, Loading, Notice, buttonPrimary, buttonSecondary } from '../components/ui'

export function DashboardPage(): JSX.Element {
  const { user } = useAuth()

  const upcoming = useResource(() => api.myBookings('upcoming'), [])

  const canBook = user !== null && user.role !== 'student'
  const bookings = upcoming.data ?? []
  const soon = bookings.slice(0, 4)

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl">Hello, {user?.displayName}</h1>
        <p className="text-campus-600 mt-1">
          {user?.roleLabel}
          {user?.department ? ` · ${user.department}` : ''}
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="surface p-5">
          <p className="text-sm text-campus-500">Upcoming bookings</p>
          <p className="text-3xl font-semibold text-campus-900 tabular mt-1">{bookings.length}</p>
          <Link to="/bookings" className="text-sm text-brand-600 hover:underline mt-2 inline-block">
            View all
          </Link>
        </div>

        <div className="surface p-5">
          <p className="text-sm text-campus-500">Today</p>
          <p className="text-3xl font-semibold text-campus-900 tabular mt-1">
            {bookings.filter((booking) => isToday(booking.startTime)).length}
          </p>
          <p className="text-xs text-campus-500 mt-2">Bookings starting today</p>
        </div>

        <div className="surface p-5">
          <p className="text-sm text-campus-500">Find a room</p>
          <p className="text-sm text-campus-600 mt-2">
            {canBook
              ? 'Search the directory, check the schedule, and confirm a booking immediately.'
              : 'Browse every facility and its schedule. Booking is available to class representatives.'}
          </p>
          <Link to="/facilities" className={`${buttonPrimary} mt-3`}>
            Open directory
          </Link>
          <Link to="/suggest" className="text-sm text-brand-600 hover:underline mt-3 block">
            Or let the app suggest a room
          </Link>
        </div>
      </section>

      <section>
        <div className="flex items-end justify-between mb-4">
          <h2 className="text-lg">Coming up</h2>
          {bookings.length > soon.length ? (
            <Link to="/bookings" className="text-sm text-brand-600 hover:underline">
              All {bookings.length} bookings
            </Link>
          ) : null}
        </div>

        {upcoming.loading ? (
          <Loading label="Loading your bookings…" />
        ) : upcoming.error ? (
          <ErrorBanner error={upcoming.error} onRetry={upcoming.reload} title="Could not load your bookings" />
        ) : soon.length === 0 ? (
          <Notice>
            Nothing booked yet.{' '}
            <Link to="/facilities" className="text-brand-600 underline">
              Find a room
            </Link>{' '}
            to get started.
          </Notice>
        ) : (
          <ul className="space-y-3">
            {soon.map((booking) => (
              <li key={booking.id} className="surface p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-campus-900">
                    <Link to={`/bookings/${booking.id}`} className="hover:text-brand-700">
                      {booking.facilityName}
                    </Link>
                  </p>
                  <p className="text-sm text-campus-600">
                    {describeDay(booking.startTime)} · {formatTimeRange(booking.startTime, booking.endTime)} ·{' '}
                    {booking.facilityBuilding}
                  </p>
                  <p className="text-xs text-campus-500 mt-0.5">
                    {booking.reference} · {booking.activityPurpose}
                  </p>
                </div>
                <BookingStatusBadge status={booking.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="surface p-5">
        <h2 className="text-lg mb-3">What you can do</h2>
        <ul className="space-y-2 text-sm text-campus-700">
          <li>• Browse every facility, with its equipment, capacity and opening hours.</li>
          <li>• See any facility&rsquo;s schedule for a chosen day, including maintenance blocks.</li>
          {canBook ? (
            <li>
              • Book an eligible, free slot and have it <strong>confirmed immediately</strong>, with
              no administrator approval step.
            </li>
          ) : (
            <li className="text-campus-500">
              • Booking is limited to class representatives. Sign in with a representative account
              to make one.
            </li>
          )}
          {canBook ? <li>• Cancel your own bookings while they are still upcoming.</li> : null}
          <li>• See what each facility is approved for - a laboratory is not a lecture hall.</li>
        </ul>

        <div className="flex flex-wrap gap-3 mt-5">
          <Link to="/facilities" className={buttonSecondary}>
            Find a free room
          </Link>
          <Link to="/bookings" className={buttonSecondary}>
            My bookings
          </Link>
        </div>
      </section>
    </div>
  )
}
