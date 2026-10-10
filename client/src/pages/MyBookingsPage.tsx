/**
 * A user's bookings.
 *
 * "Past" includes cancelled bookings rather than only elapsed ones. Somebody who
 * cancelled something a week ago and now wants to check needs to find it; a
 * history that quietly drops cancellations looks like data loss.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { api } from '../lib/api'
import { describeDay, formatDuration, formatTimeRange } from '../lib/time'
import { useResource } from '../hooks/useResource'
import { BookingStatusBadge, EmptyState, ErrorBanner, Loading, buttonSecondary } from '../components/ui'

type Scope = 'upcoming' | 'past' | 'all'

const TABS: Array<{ value: Scope; label: string }> = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past and cancelled' },
  { value: 'all', label: 'All' },
]

export function MyBookingsPage(): JSX.Element {
  const [scope, setScope] = useState<Scope>('upcoming')

  const bookings = useResource(() => api.myBookings(scope), [scope])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl">My bookings</h1>
          <p className="text-campus-600 mt-1">Everything you have booked, with its reference.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link to="/facilities" className={buttonSecondary}>
            Book another room
          </Link>
          <Link to="/suggest" className={buttonSecondary}>
            Find me a room
          </Link>
        </div>
      </header>

      <div role="tablist" aria-label="Booking history" className="flex flex-wrap gap-1 border-b border-campus-200">
        {TABS.map((tab) => {
          const isActive = tab.value === scope

          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setScope(tab.value)}
              className={[
                'px-4 py-2 text-sm font-medium -mb-px border-b-2',
                isActive
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-campus-600 hover:text-campus-900',
              ].join(' ')}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {bookings.loading ? (
        <Loading label="Loading bookings…" />
      ) : bookings.error ? (
        <ErrorBanner error={bookings.error} onRetry={bookings.reload} title="Could not load your bookings" />
      ) : (bookings.data?.length ?? 0) === 0 ? (
        <EmptyState
          title={scope === 'upcoming' ? 'Nothing coming up' : 'Nothing here'}
          description={
            scope === 'upcoming'
              ? 'You have no confirmed bookings in the future. Search the directory for a free room, or ask for a suggestion.'
              : 'No bookings of yours fall into this view.'
          }
          action={{ label: 'Find a room', to: '/facilities' }}
        />
      ) : (
        <ul className="space-y-3">
          {(bookings.data ?? []).map((booking) => (
            <li key={booking.id} className="surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg">
                    <Link to={`/bookings/${booking.id}`} className="hover:text-brand-700">
                      {booking.facilityName}
                    </Link>
                  </h2>
                  <p className="text-sm text-campus-600 mt-0.5">
                    {booking.facilityBuilding} · {booking.facilityCategory}
                  </p>
                </div>
                <BookingStatusBadge status={booking.status} />
              </div>

              <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-3 text-sm">
                <div>
                  <dt className="text-campus-500">When</dt>
                  <dd className="text-campus-900 font-medium">
                    {describeDay(booking.startTime)}, {formatTimeRange(booking.startTime, booking.endTime)}
                  </dd>
                </div>
                <div>
                  <dt className="text-campus-500">Purpose</dt>
                  <dd className="text-campus-900 font-medium">{booking.activityPurpose}</dd>
                </div>
                <div>
                  <dt className="text-campus-500">Reference</dt>
                  <dd className="text-campus-900 font-medium tabular">{booking.reference}</dd>
                </div>
              </dl>

              <div className="mt-4 pt-4 border-t border-campus-200 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-campus-500">
                  {formatDuration(booking.durationMinutes)} · {booking.expectedAttendance} expected
                  {booking.cancelledAt
                    ? ` · cancelled ${describeDay(booking.cancelledAt).toLowerCase()}`
                    : ''}
                </p>
                <Link to={`/bookings/${booking.id}`} className="text-sm font-medium text-brand-600 hover:underline">
                  View details
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
