/**
 * A single facility: what it is, and what its day looks like.
 *
 * ===========================================================================
 * THE SCHEDULE IS DESCRIBED FOR WHAT IT IS
 * ===========================================================================
 *
 * A "free" slot here means no confirmed booking and no block is recorded for
 * that time. It does NOT mean the room is empty - a class may be sitting in it
 * that nobody booked through this system, and no software can know that. The
 * wording on the page says so, because the alternative is the application
 * asserting something it cannot verify.
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { useIdentity } from '../identity/IdentityContext'
import { api } from '../lib/api'
import { mayBook, POLICY_LABELS, whyCannotBook } from '../lib/roles'
import { addDays, formatLocalDateLong, formatTime, formatTimeRange, todayLocalDate, weekdayName } from '../lib/time'
import { useResource } from '../hooks/useResource'
import {
  ErrorBanner,
  FacilityStatusBadge,
  Loading,
  Notice,
  Tag,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from '../components/ui'

export function FacilityDetailPage(): JSX.Element {
  const { id = '' } = useParams()
  const { user } = useIdentity()

  const [date, setDate] = useState(todayLocalDate())

  const facility = useResource(() => api.facility(id), [id])
  const availability = useResource(() => api.availability(id, date), [id, date])

  if (facility.loading) return <Loading label="Loading facility…" />
  if (facility.error) {
    return <ErrorBanner error={facility.error} onRetry={facility.reload} title="Could not load this facility" />
  }
  if (!facility.data) return <Notice>That facility could not be found.</Notice>

  const room = facility.data
  const bookable = mayBook(user, room)
  const reason = whyCannotBook(user, room)
  const day = availability.data

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/facilities" className="text-brand-600 hover:underline">
          Find a room
        </Link>
        <span className="text-campus-400"> / </span>
        <span className="text-campus-600">{room.name}</span>
      </nav>

      <header className="surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl">{room.name}</h1>
            <p className="text-campus-600 mt-1">
              {room.building} · {room.categoryName}
            </p>
            <p className="text-sm text-campus-500 mt-0.5">{room.locationDescription}</p>
          </div>
          <FacilityStatusBadge status={room.status} />
        </div>

        <p className="text-campus-700 mt-4 max-w-prose">{room.description}</p>

        <dl className="grid gap-4 sm:grid-cols-3 mt-6 text-sm">
          <div>
            <dt className="text-campus-500">Capacity</dt>
            <dd className="text-campus-900 font-medium tabular">{room.capacity} people</dd>
          </div>
          <div>
            <dt className="text-campus-500">Opening hours</dt>
            <dd className="text-campus-900 font-medium tabular">
              {room.opensAt}-{room.closesAt}
            </dd>
          </div>
          <div>
            <dt className="text-campus-500">Booking policy</dt>
            <dd className="text-campus-900 font-medium">{POLICY_LABELS[room.bookingPolicy] ?? room.bookingPolicy}</dd>
          </div>
        </dl>

        {room.closedDays.length > 0 ? (
          <p className="text-sm text-campus-500 mt-4">
            Closed on{' '}
            <span className="text-campus-700">
              {room.closedDays
                .slice()
                .sort()
                .map((dayIndex) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayIndex])
                .join(', ')}
            </span>
            .
          </p>
        ) : null}

        {room.bufferMinutes > 0 ? (
          <p className="text-sm text-campus-500 mt-2">
            A <span className="text-campus-700">{room.bufferMinutes}-minute</span> preparation gap is
            required between bookings.
          </p>
        ) : null}

        {room.equipment.length > 0 ? (
          <div className="mt-5">
            <p className="text-sm text-campus-500 mb-1.5">Equipment</p>
            <div className="flex flex-wrap gap-1.5">
              {room.equipment.map((item) => (
                <Tag key={item}>{item}</Tag>
              ))}
            </div>
          </div>
        ) : null}

        {room.accessibility.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm text-campus-500 mb-1.5">Accessibility</p>
            <div className="flex flex-wrap gap-1.5">
              {room.accessibility.map((item) => (
                <Tag key={item}>{item}</Tag>
              ))}
            </div>
          </div>
        ) : null}

        {room.allowedActivities.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm text-campus-500 mb-1.5">Approved for</p>
            <div className="flex flex-wrap gap-1.5">
              {room.allowedActivities.map((item) => (
                <Tag key={item}>{item}</Tag>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-6 pt-5 border-t border-campus-200 flex items-center justify-between gap-4 flex-wrap">
          {bookable ? (
            <Link to={`/facilities/${room.id}/book`} className={buttonPrimary}>
              Book this room
            </Link>
          ) : (
            <p className="text-sm text-campus-600">{reason}</p>
          )}
        </div>
      </header>

      <section className="surface p-6">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
          <div>
            <h2 className="text-lg">Schedule</h2>
            <p className="text-sm text-campus-600">
              {formatLocalDateLong(date)} · {weekdayName(date)}
            </p>
          </div>

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setDate(addDays(date, -1))}
              className={buttonSecondary}
              aria-label="Previous day"
            >
              ←
            </button>
            <div>
              <label htmlFor="schedule-date" className="visually-hidden">
                Date
              </label>
              <input
                id="schedule-date"
                type="date"
                value={date}
                min={todayLocalDate()}
                onChange={(event) => setDate(event.target.value || todayLocalDate())}
                className={inputClass}
              />
            </div>
            <button
              type="button"
              onClick={() => setDate(addDays(date, 1))}
              className={buttonSecondary}
              aria-label="Next day"
            >
              →
            </button>
          </div>
        </div>

        {availability.loading ? (
          <Loading label="Loading the schedule…" />
        ) : availability.error ? (
          <ErrorBanner
            error={availability.error}
            onRetry={availability.reload}
            title="Could not load the schedule"
          />
        ) : day ? (
          <div className="space-y-5">
            {day.closedReason ? (
              <Notice>{day.closedReason}</Notice>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                  <span className="text-campus-500">
                    Open{' '}
                    <span className="text-campus-900 tabular">
                      {day.window?.opensAt}-{day.window?.closesAt}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-rose-400" aria-hidden="true" />
                    <span className="text-campus-600">Booked or blocked</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" aria-hidden="true" />
                    <span className="text-campus-600">No booking recorded</span>
                  </span>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-campus-700 mb-2">
                    Taken ({day.busy.length})
                  </h3>

                  {day.busy.length === 0 ? (
                    <p className="text-sm text-campus-500">Nothing is booked or blocked on this day.</p>
                  ) : (
                    <ul className="space-y-2">
                      {day.busy.map((period) => (
                        <li
                          key={`${period.kind}-${period.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-campus-200 p-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-campus-900 tabular">
                              {formatTimeRange(period.startTime, period.endTime)}
                            </p>
                            <p className="text-sm text-campus-600">{period.activityPurpose}</p>
                          </div>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              period.kind === 'block'
                                ? 'bg-accent-100 text-accent-700'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {period.kind === 'block' ? 'Blocked' : 'Booked'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="text-sm font-medium text-campus-700 mb-2">
                    Not recorded as booked ({day.freeSlots.length})
                  </h3>

                  {day.freeSlots.length === 0 ? (
                    <p className="text-sm text-campus-500">No gaps left in the operating day.</p>
                  ) : (
                    <ul className="space-y-2">
                      {day.freeSlots.map((slot) => (
                        <li
                          key={`${slot.startTime}-${slot.endTime}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-campus-200 p-3"
                        >
                          <div>
                            <p className="text-sm font-medium text-campus-900 tabular">
                              {formatTimeRange(slot.startTime, slot.endTime)}
                            </p>
                            <p className="text-xs text-campus-500">{slot.minutes} minutes free</p>
                          </div>

                          {bookable && !day.isPast && slot.minutes >= room.slotMinutes ? (
                            // The suggested end time is one booking slot long, but
                            // never runs past the end of the gap it sits in - that
                            // would produce a link that the server would refuse.
                            <Link
                              to={`/facilities/${room.id}/book?date=${date}&start=${formatTime(slot.startTime)}&end=${formatTime(
                                new Date(
                                  Math.min(
                                    new Date(slot.startTime).getTime() + room.slotMinutes * 60_000,
                                    new Date(slot.endTime).getTime(),
                                  ),
                                ).toISOString(),
                              )}`}
                              className="text-sm font-medium text-brand-600 hover:underline"
                            >
                              Book {room.slotMinutes} minutes
                            </Link>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <p className="text-xs text-campus-500">
                  &ldquo;Not recorded as booked&rdquo; means no booking or block exists in this system
                  for that time. It is not a promise that the room is empty.
                </p>
              </>
            )}
          </div>
        ) : null}
      </section>
    </div>
  )
}
