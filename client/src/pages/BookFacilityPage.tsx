/**
 * The booking form.
 *
 * ===========================================================================
 * WHAT HAPPENS WHEN IT IS SUBMITTED
 * ===========================================================================
 *
 * The form sends the date and the two local times as strings, and the server
 * decides whether the booking is allowed. If it is, the booking is CONFIRMED
 * and this page navigates straight to the confirmation - there is no "pending
 * approval" state, because a booking that satisfies every published rule is
 * entitled to the room immediately.
 *
 * If it is refused, the message is the one the server wrote, and the refusal is
 * specific: which booking is in the way, that the room closes at 21:00, that a
 * 15-minute gap is required. That is the point of doing the checking on the
 * server - the honest answer already exists, so the interface shows it rather
 * than inventing a friendlier, vaguer one.
 *
 * A conflict additionally offers alternatives, obtained from the same rule set
 * the server enforces. It never suggests something it would then refuse.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { api, ApiError } from '../lib/api'
import { mayBook, whyCannotBook } from '../lib/roles'
import { addDays, formatLocalDateLong, todayLocalDate } from '../lib/time'
import type { AlternativeSuggestion, Facility } from '../lib/types'
import { useAuth } from '../auth/AuthContext'
import { useResource } from '../hooks/useResource'
import {
  ErrorBanner,
  Field,
  Loading,
  Notice,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from '../components/ui'

/** Deep-link fields the schedule page fills in when it offers a free gap. */
interface ConflictDetails {
  conflicting?: {
    reference?: string
    activityPurpose?: string
    startTime?: string
    endTime?: string
  }
}

export function BookFacilityPage(): JSX.Element {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()

  const facility = useResource(() => api.facility(id), [id])

  const [date, setDate] = useState(searchParams.get('date') ?? addDays(todayLocalDate(), 1))
  const [startTime, setStartTime] = useState(searchParams.get('start') ?? '09:00')
  const [endTime, setEndTime] = useState(searchParams.get('end') ?? '10:00')
  const [activityPurpose, setActivityPurpose] = useState('')
  const [expectedAttendance, setExpectedAttendance] = useState('')

  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [alternatives, setAlternatives] = useState<AlternativeSuggestion[]>([])
  const [findingAlternatives, setFindingAlternatives] = useState(false)

  // Default the activity once the facility's approved list is known: picking one
  // from a list of one is not a decision worth making the user perform.
  useEffect(() => {
    const allowed = facility.data?.allowedActivities ?? []
    if (activityPurpose === '' && allowed.length > 0) {
      setActivityPurpose(allowed[0] ?? '')
    }
  }, [facility.data, activityPurpose])

  const room: Facility | null = facility.data
  const bookable = user !== null && room !== null && mayBook(user, room)

  const fieldErrors = useMemo(() => error?.fieldErrors ?? {}, [error])

  const conflict = useMemo<ConflictDetails | null>(() => {
    if (error?.code !== 'CONFLICT') return null
    return (error.details ?? null) as ConflictDetails | null
  }, [error])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setAlternatives([])
    setSubmitting(true)

    try {
      const booking = await api.createBooking({
        facilityId: id,
        activityPurpose: activityPurpose.trim(),
        expectedAttendance: Number(expectedAttendance),
        date,
        startTime,
        endTime,
      })

      navigate(`/bookings/${booking.id}`, { replace: true, state: { justCreated: true } })
    } catch (cause) {
      const apiError =
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNEXPECTED_ERROR', 'The booking could not be created.', undefined)

      setError(apiError)
      setSubmitting(false)

      // A conflict is the one failure where the user needs options rather than
      // a correction, so alternatives are fetched straight away.
      if (apiError.code === 'CONFLICT') {
        void showAlternatives()
      }
    }
  }

  async function showAlternatives(): Promise<void> {
    setFindingAlternatives(true)

    try {
      const result = await api.recommend({
        date,
        startTime,
        endTime,
        expectedAttendance: Number(expectedAttendance) || 1,
        activityPurpose: activityPurpose.trim() || 'Session',
      })

      setAlternatives(result.alternatives)
    } catch {
      // Alternatives are a courtesy. Failing to fetch them must not replace the
      // real error, which is still on screen.
      setAlternatives([])
    } finally {
      setFindingAlternatives(false)
    }
  }

  if (facility.loading) return <Loading label="Loading facility…" />
  if (facility.error) {
    return <ErrorBanner error={facility.error} onRetry={facility.reload} title="Could not load this facility" />
  }
  if (!room) return <Notice>That facility could not be found.</Notice>

  const blockedReason = whyCannotBook(user, room)
  const allowedActivities = room.allowedActivities

  return (
    <div className="space-y-6 max-w-3xl">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/facilities" className="text-brand-600 hover:underline">
          Find a room
        </Link>
        <span className="text-campus-400"> / </span>
        <Link to={`/facilities/${room.id}`} className="text-brand-600 hover:underline">
          {room.name}
        </Link>
        <span className="text-campus-400"> / </span>
        <span className="text-campus-600">Book</span>
      </nav>

      <header>
        <h1 className="text-2xl">Book {room.name}</h1>
        <p className="text-campus-600 mt-1">
          {room.building} · holds {room.capacity} · open {room.opensAt}-{room.closesAt}
        </p>
      </header>

      {!bookable ? <Notice>{blockedReason}</Notice> : null}

      {error ? (
        <ErrorBanner
          error={error}
          title={error.code === 'CONFLICT' ? 'That slot is taken' : 'Booking not created'}
        />
      ) : null}

      {error && Object.keys(fieldErrors).length > 0 ? (
        <ul className="text-sm text-rose-800 list-disc pl-5">
          {Object.entries(fieldErrors).map(([field, message]) => (
            <li key={field}>
              {field === '_form' ? message : `${field}: ${message}`}
            </li>
          ))}
        </ul>
      ) : null}

      {conflict?.conflicting ? (
        <Notice tone="info">
          <p className="font-medium">Already booked at that time</p>
          <p className="mt-1">
            {conflict.conflicting.activityPurpose} ·{' '}
            {formatLocalDateLong(date)} · reference {conflict.conflicting.reference}
          </p>
        </Notice>
      ) : null}

      {findingAlternatives ? <Loading label="Looking for times that are free…" /> : null}

      {alternatives.length > 0 ? (
        <section className="surface p-5">
          <h2 className="text-base mb-3">Times that are free</h2>
          <ul className="space-y-2">
            {alternatives.map((alternative) => (
              <li
                key={`${alternative.facilityId}-${alternative.date}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-campus-200 p-3"
              >
                <div>
                  <p className="text-sm font-medium text-campus-900">{alternative.facilityName}</p>
                  <p className="text-sm text-campus-600">
                    {alternative.displayDate} · {alternative.startTime}-{alternative.endTime}
                  </p>
                  <p className="text-xs text-campus-500">{alternative.note}</p>
                </div>

                <Link
                  to={`/facilities/${alternative.facilityId}/book?date=${alternative.date}&start=${alternative.startTime}&end=${alternative.endTime}`}
                  className={buttonSecondary}
                >
                  Use this
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <form onSubmit={(event) => void submit(event)} className="surface p-6 space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              label="Date"
              htmlFor="date"
              required
              hint={`Campus time (Africa/Nairobi). Today is ${formatLocalDateLong(todayLocalDate())}.`}
            >
              <input
                id="date"
                type="date"
                required
                min={todayLocalDate()}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Start time" htmlFor="startTime" required>
            <input
              id="startTime"
              type="time"
              required
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="End time" htmlFor="endTime" required>
            <input
              id="endTime"
              type="time"
              required
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className={inputClass}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Purpose"
              htmlFor="activityPurpose"
              required
              hint={
                allowedActivities.length > 0
                  ? `This facility is approved for: ${allowedActivities.join(', ')}.`
                  : 'Describe what the room is needed for.'
              }
            >
              {allowedActivities.length > 0 ? (
                <select
                  id="activityPurpose"
                  required
                  value={activityPurpose}
                  onChange={(event) => setActivityPurpose(event.target.value)}
                  className={inputClass}
                >
                  {allowedActivities.map((activity) => (
                    <option key={activity} value={activity}>
                      {activity}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="activityPurpose"
                  required
                  minLength={3}
                  maxLength={120}
                  value={activityPurpose}
                  onChange={(event) => setActivityPurpose(event.target.value)}
                  className={inputClass}
                  placeholder="e.g. Revision session"
                />
              )}
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              label="Expected attendance"
              htmlFor="expectedAttendance"
              required
              hint={`This room holds ${room.capacity}.`}
            >
              <input
                id="expectedAttendance"
                type="number"
                required
                min={1}
                max={room.capacity}
                value={expectedAttendance}
                onChange={(event) => setExpectedAttendance(event.target.value)}
                className={inputClass}
                placeholder={`1 to ${room.capacity}`}
              />
            </Field>
          </div>
        </div>

        <div className="pt-4 border-t border-campus-200 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={submitting || !bookable} className={buttonPrimary}>
            {submitting ? 'Booking…' : 'Confirm booking'}
          </button>
          <Link to={`/facilities/${room.id}`} className={buttonSecondary}>
            Check the schedule first
          </Link>
        </div>

        <p className="text-xs text-campus-500">
          Your booking is confirmed immediately if it satisfies the facility&rsquo;s rules. If the
          slot is already taken, the request will be refused and you will be offered alternatives.
        </p>
      </form>
    </div>
  )
}
