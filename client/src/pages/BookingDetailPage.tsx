/**
 * A single booking: the confirmation screen, and where a booking is cancelled.
 *
 * The confirmation is deliberately explicit about what has happened. A person
 * who has just booked a room needs to know that it is CONFIRMED - not pending,
 * not awaiting approval - and what the reference is, because that reference is
 * what the facilities office will ask for if anything goes wrong.
 */
import { useState, type FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import { useIdentity } from '../identity/IdentityContext'
import { api, ApiError } from '../lib/api'
import { describeDay, formatDuration, formatInstant, formatTimeRange, isPast } from '../lib/time'
import { useResource } from '../hooks/useResource'
import {
  BookingStatusBadge,
  ErrorBanner,
  Field,
  Loading,
  Notice,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from '../components/ui'

interface LocationState {
  justCreated?: boolean
}

export function BookingDetailPage(): JSX.Element {
  const { id = '' } = useParams()
  const { user } = useIdentity()
  const location = useLocation()

  const justCreated = (location.state as LocationState | null)?.justCreated === true

  const booking = useResource(() => api.booking(id), [id])

  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<ApiError | null>(null)

  async function cancel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setCancelling(true)
    setCancelError(null)

    try {
      await api.cancelBooking(id, reason.trim())
      booking.reload()
    } catch (cause) {
      setCancelError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNEXPECTED_ERROR', 'The booking could not be cancelled.', undefined),
      )
    } finally {
      setCancelling(false)
    }
  }

  if (booking.loading) return <Loading label="Loading booking…" />
  if (booking.error) {
    return <ErrorBanner error={booking.error} onRetry={booking.reload} title="Could not load this booking" />
  }
  if (!booking.data) return <Notice>That booking could not be found.</Notice>

  const record = booking.data
  const isOwner = user?.id === record.bookedById
  const isAdmin = user?.role === 'admin'
  const started = isPast(record.startTime)

  const mayCancel =
    record.status === 'confirmed' && (isOwner || isAdmin) && (!started || isAdmin)

  return (
    <div className="space-y-6 max-w-3xl">
      {justCreated ? (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-900"
        >
          <h2 className="text-lg">Booking confirmed</h2>
          <p className="mt-1 text-sm">
            {record.facilityName} is yours for {formatTimeRange(record.startTime, record.endTime)} on{' '}
            {describeDay(record.startTime)}. No approval step is needed - the rules were satisfied, so
            the room is booked.
          </p>
          <p className="mt-2 text-sm">
            Your reference is <strong className="tabular">{record.reference}</strong>. Keep it for the
            facilities office.
          </p>
        </div>
      ) : null}

      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/bookings" className="text-brand-600 hover:underline">
          My bookings
        </Link>
        <span className="text-campus-400"> / </span>
        <span className="text-campus-600 tabular">{record.reference}</span>
      </nav>

      <header className="surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl">{record.facilityName}</h1>
            <p className="text-campus-600 mt-1">
              {record.facilityBuilding} · {record.facilityCategory}
            </p>
          </div>
          <BookingStatusBadge status={record.status} />
        </div>

        <dl className="grid gap-5 sm:grid-cols-2 mt-6 text-sm">
          <div>
            <dt className="text-campus-500">Starts</dt>
            <dd className="text-campus-900 font-medium">{formatInstant(record.startTime)}</dd>
          </div>
          <div>
            <dt className="text-campus-500">Ends</dt>
            <dd className="text-campus-900 font-medium">{formatInstant(record.endTime)}</dd>
          </div>
          <div>
            <dt className="text-campus-500">Duration</dt>
            <dd className="text-campus-900 font-medium tabular">
              {formatDuration(record.durationMinutes)}
            </dd>
          </div>
          <div>
            <dt className="text-campus-500">Expected attendance</dt>
            <dd className="text-campus-900 font-medium tabular">{record.expectedAttendance}</dd>
          </div>
          <div>
            <dt className="text-campus-500">Purpose</dt>
            <dd className="text-campus-900 font-medium">{record.activityPurpose}</dd>
          </div>
          <div>
            <dt className="text-campus-500">Booked by</dt>
            <dd className="text-campus-900 font-medium">
              {record.bookedByName}
              {isOwner ? ' (you)' : ''}
            </dd>
          </div>
          <div>
            <dt className="text-campus-500">Reference</dt>
            <dd className="text-campus-900 font-medium tabular">{record.reference}</dd>
          </div>
          <div>
            <dt className="text-campus-500">Requested</dt>
            <dd className="text-campus-900 font-medium">{formatInstant(record.createdAt)}</dd>
          </div>
        </dl>

        {record.status === 'cancelled' ? (
          <div className="mt-6 pt-5 border-t border-campus-200">
            <Notice>
              <p className="font-medium">This booking was cancelled</p>
              <p className="mt-1">
                {formatInstant(record.cancelledAt ?? record.updatedAt)}
                {record.cancelledByName ? ` by ${record.cancelledByName}` : ''}.
              </p>
              {record.cancellationReason ? <p className="mt-1">Reason: {record.cancellationReason}</p> : null}
              <p className="mt-1 text-campus-500">The slot has been released for others to book.</p>
            </Notice>
          </div>
        ) : null}

        <div className="mt-6 pt-5 border-t border-campus-200 flex flex-wrap gap-3">
          <Link to={`/facilities/${record.facilityId}`} className={buttonSecondary}>
            See this facility
          </Link>
          <Link to="/bookings" className={buttonSecondary}>
            All my bookings
          </Link>
        </div>
      </header>

      {mayCancel ? (
        <section className="surface p-6">
          <h2 className="text-lg mb-1">Cancel this booking</h2>
          <p className="text-sm text-campus-600 mb-4">
            Cancelling releases the slot immediately, so someone else can use it.
            {isAdmin && !isOwner ? ' As an administrator you can cancel a booking that has already started.' : ''}
          </p>

          {cancelError ? (
            <div className="mb-4">
              <ErrorBanner error={cancelError} title="Could not cancel" />
            </div>
          ) : null}

          <form onSubmit={(event) => void cancel(event)} className="space-y-4">
            <Field
              label="Reason"
              htmlFor="reason"
              hint="Optional, but recorded in the audit trail and visible to the facilities office."
            >
              <input
                id="reason"
                maxLength={400}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={inputClass}
                placeholder="e.g. Class rescheduled to next week"
              />
            </Field>

            <button type="submit" disabled={cancelling} className={buttonPrimary}>
              {cancelling ? 'Cancelling…' : 'Cancel booking'}
            </button>
          </form>
        </section>
      ) : record.status === 'confirmed' ? (
        <Notice>
          This booking has already started, so it can no longer be cancelled from here. Contact the
          facilities office if it needs to change.
        </Notice>
      ) : null}
    </div>
  )
}
