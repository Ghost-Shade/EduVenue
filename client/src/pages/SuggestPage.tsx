/**
 * "Which room should I use?"
 *
 * ===========================================================================
 * THIS IS A RULES ENGINE, NOT ARTIFICIAL INTELLIGENCE
 * ===========================================================================
 *
 * It filters, ranks and explains, deterministically. The same request always
 * produces the same answer, and every result carries the reasons it was ranked
 * where it was. The page says so on screen rather than implying a model is
 * involved, because a booking suggestion nobody can interrogate is not worth
 * trusting - especially when a wrong answer means a class turns up at a locked
 * door.
 *
 * ===========================================================================
 * IT IS HONEST ABOUT FAILURE
 * ===========================================================================
 *
 * When nothing fits, the page shows the rule each candidate failed and, where
 * one exists, a concrete different time that IS free. "No results" on its own
 * would leave the user with nothing to act on.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { useIdentity } from '../identity/IdentityContext'
import { api, ApiError } from '../lib/api'
import { addDays, formatDuration, formatLocalDateLong, todayLocalDate } from '../lib/time'
import type { Category, RecommendationResult } from '../lib/types'
import {
  ErrorBanner,
  Field,
  Loading,
  Notice,
  Tag,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from '../components/ui'

export function SuggestPage(): JSX.Element {
  const { user } = useIdentity()

  const [date, setDate] = useState(addDays(todayLocalDate(), 1))
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('11:00')
  const [expectedAttendance, setExpectedAttendance] = useState('40')
  const [activityPurpose, setActivityPurpose] = useState('Revision session')
  const [preferredCategoryId, setPreferredCategoryId] = useState('')
  const [preferredBuilding, setPreferredBuilding] = useState('')

  const [categories, setCategories] = useState<Category[]>([])
  const [buildings, setBuildings] = useState<string[]>([])
  const [result, setResult] = useState<RecommendationResult | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    let cancelled = false

    Promise.all([api.categories(), api.buildings()])
      .then(([nextCategories, nextBuildings]) => {
        if (cancelled) return
        setCategories(nextCategories)
        setBuildings(nextBuildings)
      })
      .catch(() => {
        // The preferences below are optional. Without them the search still
        // runs correctly, it simply cannot weight towards a preferred area.
      })

    return () => {
      cancelled = true
    }
  }, [])

  const canBook = user !== null && user.role !== 'student'

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setSearching(true)
    setError(null)
    setResult(null)

    try {
      const next = await api.recommend({
        date,
        startTime,
        endTime,
        expectedAttendance: Number(expectedAttendance),
        activityPurpose: activityPurpose.trim(),
        preferredCategoryId: preferredCategoryId || undefined,
        preferredBuilding: preferredBuilding || undefined,
      })

      setResult(next)
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNEXPECTED_ERROR', 'The search could not be completed.', undefined),
      )
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl">Find me a room</h1>
        <p className="text-campus-600 mt-1 max-w-prose">
          Describe what you need and this matches it against every facility, then explains its
          choices. It applies the same rules the booking system enforces, so anything it suggests is
          something you can actually book.
        </p>
      </header>

      {!canBook ? (
        <Notice>
          You are acting as a {user?.role}. You can search and see the reasoning, but booking is
          limited to class representatives and supervisors. Switch identity in the header to book.
        </Notice>
      ) : null}

      <form onSubmit={(event) => void search(event)} className="surface p-6 space-y-5">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Date" htmlFor="date" required>
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

          <Field label="From" htmlFor="startTime" required>
            <input
              id="startTime"
              type="time"
              required
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="To" htmlFor="endTime" required>
            <input
              id="endTime"
              type="time"
              required
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className={inputClass}
            />
          </Field>

          <div className="sm:col-span-2 lg:col-span-1">
            <Field label="What for" htmlFor="activityPurpose" required hint="Exactly as the facility lists it.">
              <input
                id="activityPurpose"
                required
                minLength={3}
                maxLength={120}
                value={activityPurpose}
                onChange={(event) => setActivityPurpose(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="How many people" htmlFor="expectedAttendance" required>
            <input
              id="expectedAttendance"
              type="number"
              required
              min={1}
              max={5000}
              value={expectedAttendance}
              onChange={(event) => setExpectedAttendance(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Preferred category" htmlFor="preferredCategoryId" hint="Optional. Raises, never restricts.">
            <select
              id="preferredCategoryId"
              value={preferredCategoryId}
              onChange={(event) => setPreferredCategoryId(event.target.value)}
              className={inputClass}
            >
              <option value="">No preference</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Preferred building" htmlFor="preferredBuilding" hint="Optional. Raises, never restricts.">
            <select
              id="preferredBuilding"
              value={preferredBuilding}
              onChange={(event) => setPreferredBuilding(event.target.value)}
              className={inputClass}
            >
              <option value="">No preference</option>
              {buildings.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="pt-4 border-t border-campus-200 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={searching} className={buttonPrimary}>
            {searching ? 'Searching…' : 'Suggest a room'}
          </button>
          <Link to="/facilities" className={buttonSecondary}>
            Browse the directory instead
          </Link>
        </div>
      </form>

      {searching ? <Loading label="Checking every facility…" /> : null}

      {error ? <ErrorBanner error={error} title="The search could not run" /> : null}

      {result?.problem ? <Notice>{result.problem}</Notice> : null}

      {result && !result.problem ? (
        <>
          <section>
            <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
              <h2 className="text-lg">
                {result.recommendations.length} suggestion
                {result.recommendations.length === 1 ? '' : 's'}
              </h2>
              <p className="text-sm text-campus-500">
                Chosen from {result.consideredCount} facilities ·{' '}
                {formatLocalDateLong(result.requested.date)} · {result.requested.startTime}-
                {result.requested.endTime} ({formatDuration(result.requested.durationMinutes)})
              </p>
            </div>

            {result.recommendations.length === 0 ? (
              <Notice>
                No facility can take that request. Every one was checked, and the reason each was
                ruled out is listed below.
              </Notice>
            ) : (
              <ol className="space-y-4">
                {result.recommendations.map((recommendation, index) => (
                  <li key={recommendation.facility.id} className="surface p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-lg">
                          <span className="text-campus-400 mr-2 tabular">{index + 1}.</span>
                          <Link
                            to={`/facilities/${recommendation.facility.id}`}
                            className="hover:text-brand-700"
                          >
                            {recommendation.facility.name}
                          </Link>
                        </h3>
                        <p className="text-sm text-campus-600 mt-0.5">
                          {recommendation.facility.building} · holds {recommendation.facility.capacity} ·
                          uses {recommendation.capacityFitPercent}% of the seats
                        </p>
                      </div>

                      {index === 0 ? <Tag>Best match</Tag> : null}
                    </div>

                    <ul className="mt-3 space-y-1 text-sm text-campus-700 list-disc pl-5">
                      {recommendation.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>

                    <div className="mt-4 flex flex-wrap gap-3">
                      <Link to={`/facilities/${recommendation.facility.id}`} className={buttonSecondary}>
                        See the schedule
                      </Link>
                      {canBook ? (
                        <Link
                          to={`/facilities/${recommendation.facility.id}/book?date=${result.requested.date}&start=${result.requested.startTime}&end=${result.requested.endTime}`}
                          className={buttonPrimary}
                        >
                          Book this
                        </Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {result.alternatives.length > 0 ? (
            <section className="surface p-5">
              <h2 className="text-lg mb-1">Other times that are free</h2>
              <p className="text-sm text-campus-600 mb-4">
                Nothing was available at the time you asked for, but these are. Each one has been
                checked against the full rule set for that exact facility and time.
              </p>

              <ul className="space-y-2">
                {result.alternatives.map((alternative) => (
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

          {result.rejected.length > 0 ? (
            <section className="surface p-5">
              <h2 className="text-lg mb-1">Ruled out, and why</h2>
              <p className="text-sm text-campus-600 mb-4">
                These are the facilities that were considered and could not be offered. The reason is
                the rule that stopped them, not a guess.
              </p>

              <ul className="space-y-2">
                {result.rejected.map((rejection) => (
                  <li key={rejection.facilityId} className="rounded-lg border border-campus-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-campus-900">
                        <Link to={`/facilities/${rejection.facilityId}`} className="hover:text-brand-700">
                          {rejection.facilityName}
                        </Link>
                      </p>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-campus-100 text-campus-600">
                        {rejection.code.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    </div>
                    <p className="text-sm text-campus-600 mt-1">{rejection.reason}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
