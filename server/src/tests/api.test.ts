/**
 * API-level tests: the whole request path, over real HTTP.
 *
 * ===========================================================================
 * WHY THESE EXIST ALONGSIDE THE SERVICE TESTS
 * ===========================================================================
 *
 * booking.test.ts calls the booking service directly, which proves the rules.
 * These tests prove the rules are actually reachable through the API and that
 * the guards in front of them hold: identity resolution, the role gates on the
 * routes, the error shape the client parses, and the fact that a student
 * reaching the endpoint by hand still gets nothing.
 *
 * The concurrency test lives here rather than in the service tests because the
 * guarantee being claimed is about the SERVER: eight simultaneous HTTP requests,
 * one slot, exactly one confirmation. Anything less end-to-end would not be
 * evidence for that claim.
 *
 * ===========================================================================
 * THE CONCURRENCY TEST NOW EXERCISES THE REAL MECHANISM
 * ===========================================================================
 *
 * Under SQLite this test passed because `BEGIN IMMEDIATE` serialised the whole
 * booking operation inside one process. That is no longer what protects the
 * slot: `bookings_no_overlap` does, and it is enforced by PostgreSQL.
 *
 * The expected outcome is unchanged - one 201 and seven 409s - but the ROUTE to
 * the 409 is now either of two paths, and the test insists both produce the same
 * body:
 *
 *   - the pre-check saw the committed booking and reported it (the common case);
 *   - the insert hit the exclusion constraint (SQLSTATE 23P01) because the row
 *     was committed between the check and the insert. bookingService.ts catches
 *     that and re-describes it as an ordinary conflict.
 *
 * A test that only accepted the first path would pass while the race path
 * returned a 500, which is exactly the failure that would take down a live
 * demo under load.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import './env.ts'
import { combineLocalDateTimeToUtc } from '../lib/time.ts'
import { queryOne } from '../db/connection.ts'
import { getFacilityOrThrow } from '../services/facilityService.ts'
import {
  actAs,
  allocateOpenDate,
  apiRequest,
  errorCode,
  identityCookieFrom,
  prepareTestDatabase,
  startTestServer,
  type HttpResponse,
  type TestServer,
} from './harness.ts'

await prepareTestDatabase()

const lectureHallA = await getFacilityOrThrow('fac-lecture-hall-a')

const rep = await actAs('user-rep-brian')
const rep2 = await actAs('user-rep-cynthia')
const student = await actAs('user-student')

let server: TestServer

before(async () => {
  server = await startTestServer()
})

after(async () => {
  await server.close()
})

/** Reads `error.code` out of a response, failing loudly if there is none. */
function codeOf(response: HttpResponse): string {
  const code = errorCode(response.body)
  assert.ok(code, `expected an error code in ${JSON.stringify(response.body)}`)
  return code
}

function bookingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    facilityId: lectureHallA.id,
    activityPurpose: 'Revision session',
    expectedAttendance: 40,
    date: allocateOpenDate(lectureHallA),
    startTime: '09:00',
    endTime: '10:00',
    ...overrides,
  }
}

describe('identity', () => {
  test('serves a health check without any cookie', async () => {
    const response = await apiRequest(server, '/api/health')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'ok', service: 'eduvenue-api' })
  })

  test('acts as the default identity when no cookie is sent', async () => {
    const response = await apiRequest(server, '/api/identity')

    assert.equal(response.status, 200)

    const body = response.body as {
      user: { id: string; role: string }
      identities: Array<{ id: string; role: string; roleLabel: string }>
    }

    // There is no sign-in step, so a request with no cookie is NOT an error:
    // it is the default identity, which is a representative because that is the
    // role the application is about.
    assert.equal(body.user.id, 'user-rep-brian')
    assert.equal(body.user.role, 'rep')

    // Every role is offered, so a judge can try each one without credentials.
    const roles = new Set(body.identities.map((identity) => identity.role))
    assert.deepEqual(
      [...roles].sort(),
      ['admin', 'rep', 'student', 'supervisor'],
      'the switcher should offer one identity of every role',
    )
    assert.ok(body.identities.every((identity) => identity.roleLabel.length > 0))
  })

  test('switches identity, and the new role governs the next request', async () => {
    const switched = await apiRequest(server, '/api/identity', {
      method: 'POST',
      body: { userId: 'user-student' },
    })

    assert.equal(switched.status, 200)

    const cookie = identityCookieFrom(switched)
    assert.match(cookie, /^eduvenue_actor=user-student$/)

    const whoAmI = await apiRequest(server, '/api/identity', { cookie })
    assert.equal((whoAmI.body as { user: { role: string } }).user.role, 'student')

    // The point of switching: the role is not decoration. A student is refused
    // at the booking route, exactly as a signed-in student always was.
    const booking = await apiRequest(server, '/api/bookings', {
      method: 'POST',
      cookie,
      body: bookingBody(),
    })

    assert.equal(booking.status, 403)
    assert.equal(codeOf(booking), 'FORBIDDEN')
  })

  test('a representative with no cookie can still book', async () => {
    // The end-to-end statement of "no login step": the default identity is a
    // representative, so a bare request books. This is the behaviour the whole
    // change was for, and it is worth one test that proves it through HTTP
    // rather than by reading the default constant.
    const date = allocateOpenDate(lectureHallA)

    const response = await apiRequest(server, '/api/bookings', {
      method: 'POST',
      body: {
        facilityId: lectureHallA.id,
        activityPurpose: 'Revision session',
        expectedAttendance: 30,
        date,
        startTime: '13:00',
        endTime: '14:00',
      },
    })

    assert.equal(response.status, 201)
    const booking = (response.body as { booking: { status: string; bookedById: string } }).booking
    assert.equal(booking.status, 'confirmed')
    assert.equal(booking.bookedById, 'user-rep-brian')
  })

  test('rejects an identity that does not exist, rather than appearing to switch', async () => {
    const response = await apiRequest(server, '/api/identity', {
      method: 'POST',
      body: { userId: 'user-does-not-exist' },
    })

    assert.equal(response.status, 400)
    assert.equal(codeOf(response), 'VALIDATION_FAILED')
  })

  test('falls back to the default when the cookie names a profile that is gone', async () => {
    // A re-seed resets the demo ids' contents but not a browser's cookie, and
    // this must not produce a broken empty state. The fallback is silent in the
    // response and logged on the server - see resolveActor.
    const response = await apiRequest(server, '/api/identity', {
      cookie: 'eduvenue_actor=user-deleted-long-ago',
    })

    assert.equal(response.status, 200)
    assert.equal((response.body as { user: { id: string } }).user.id, 'user-rep-brian')
  })

  test('clears the chosen identity on DELETE, returning to the default', async () => {
    const switched = await apiRequest(server, '/api/identity', {
      method: 'POST',
      body: { userId: 'user-admin' },
    })

    const cookie = identityCookieFrom(switched)

    const reset = await apiRequest(server, '/api/identity', { method: 'DELETE', cookie })

    assert.equal(reset.status, 200)
    assert.equal((reset.body as { user: { id: string } }).user.id, 'user-rep-brian')

    const afterwards = await apiRequest(server, '/api/identity', { cookie })
    assert.equal((afterwards.body as { user: { id: string } }).user.id, 'user-rep-brian')
  })

  test('has no login route at all', async () => {
    // Asserted rather than assumed: a leftover route accepting an email and a
    // password would be the most dangerous possible artefact of this change -
    // it would look like authentication while checking nothing.
    const response = await apiRequest(server, '/api/auth/login', {
      method: 'POST',
      body: { email: 'rep.brian@eduvenue.test', password: 'anything' },
    })

    assert.equal(response.status, 404)
    assert.equal(codeOf(response), 'NOT_FOUND')
  })
})

describe('the facility directory', () => {
  test('lists active facilities and reports how many there are', async () => {
    const response = await apiRequest(server, '/api/facilities', { cookie: student.cookie })

    assert.equal(response.status, 200)
    const body = response.body as { facilities: Array<{ id: string }>; count: number }
    assert.equal(body.count, body.facilities.length)
    assert.ok(body.count > 0)
  })

  test('hides withdrawn facilities by default, and shows them to an administrator on request', async () => {
    const withdrawnId = 'fac-classroom-c2'

    const asStudent = await apiRequest(server, '/api/facilities', { cookie: student.cookie })
    const studentIds = (asStudent.body as { facilities: Array<{ id: string }> }).facilities.map(
      (f) => f.id,
    )
    assert.ok(!studentIds.includes(withdrawnId))

    // A non-administrator asking for inactive facilities is quietly given the
    // normal active list, and the response says so in `filters`.
    const studentAsking = await apiRequest(server, '/api/facilities?includeInactive=true', {
      cookie: student.cookie,
    })
    const studentFilters = (studentAsking.body as { filters: { includeInactive: boolean } })
      .filters
    assert.equal(studentFilters.includeInactive, false)

    const admin = await actAs('user-admin')
    const adminAsking = await apiRequest(server, '/api/facilities?includeInactive=true', {
      cookie: admin.cookie,
    })

    const adminIds = (adminAsking.body as { facilities: Array<{ id: string }> }).facilities.map(
      (f) => f.id,
    )
    assert.ok(
      adminIds.includes(withdrawnId),
      'an administrator should be able to see withdrawn facilities',
    )
  })

  test('filters by category and by minimum capacity', async () => {
    const computing = await apiRequest(server, '/api/facilities?categoryId=cat-computing', {
      cookie: student.cookie,
    })
    const computingBody = computing.body as { facilities: Array<{ categoryId: string }> }
    assert.ok(computingBody.facilities.length > 0)
    assert.ok(computingBody.facilities.every((facility) => facility.categoryId === 'cat-computing'))

    const large = await apiRequest(server, '/api/facilities?minCapacity=100', {
      cookie: student.cookie,
    })
    const largeBody = large.body as { facilities: Array<{ capacity: number }> }
    assert.ok(largeBody.facilities.every((facility) => facility.capacity >= 100))
  })

  test('searches case-insensitively, as SQLite used to', async () => {
    // SQLite's `like` is case-insensitive for ASCII; PostgreSQL's is NOT. This
    // is the one porting change that could silently break the search box in a
    // way no other test would notice, because a lowercase query is exactly how
    // a person types. See the note at the top of services/facilityService.ts.
    const response = await apiRequest(server, '/api/facilities?q=laboratory', {
      cookie: student.cookie,
    })

    assert.equal(response.status, 200)
    const body = response.body as { facilities: Array<{ name: string }>; count: number }

    assert.ok(
      body.count > 0,
      'a lowercase search for "laboratory" should match facilities named "Computing Laboratory"',
    )
    assert.ok(
      body.facilities.every((facility) => /laboratory/i.test(facility.name)),
      'every match should contain the term regardless of case',
    )
  })

  test('treats a wildcard in a search term as a literal character', async () => {
    // A search for "%" must not return the whole directory. If the value were
    // interpolated into the ILIKE pattern unescaped, it would match everything.
    const response = await apiRequest(server, '/api/facilities?q=%25', { cookie: student.cookie })

    assert.equal(response.status, 200)
    const body = response.body as { count: number }
    assert.equal(body.count, 0)
  })

  test('matches an activity exactly, without substring bleeding', async () => {
    // The activity filter is jsonb containment, which replaced SQLite's
    // json_each. The property that matters is that it is EXACT membership: a
    // substring match on the raw JSON text would make "Revision" also match
    // "Revision session", quietly widening every filter.
    const exact = await apiRequest(server, '/api/facilities?activity=Revision%20session', {
      cookie: student.cookie,
    })

    assert.equal(exact.status, 200)
    const exactBody = exact.body as { facilities: Array<{ allowedActivities: string[] }> }
    assert.ok(exactBody.facilities.length > 0, 'the seeded activity should match something')

    for (const facility of exactBody.facilities) {
      assert.ok(
        facility.allowedActivities.includes('Revision session'),
        `${facility.allowedActivities.join(' | ')} does not contain "Revision session"`,
      )
    }

    // An activity that is a prefix of a real one must not match it.
    const prefix = await apiRequest(server, '/api/facilities?activity=Revision', {
      cookie: student.cookie,
    })
    const prefixBody = prefix.body as { facilities: Array<{ allowedActivities: string[] }> }

    for (const facility of prefixBody.facilities) {
      assert.ok(
        facility.allowedActivities.includes('Revision'),
        `"Revision" should not match a facility offering only longer activities`,
      )
    }
  })

  test('lists distinct activities for the filter dropdown', async () => {
    const response = await apiRequest(server, '/api/facilities/activities', {
      cookie: student.cookie,
    })

    assert.equal(response.status, 200)
    const body = response.body as { activities: string[] }

    assert.ok(body.activities.length > 0)
    assert.ok(body.activities.includes('Revision session'))
    assert.equal(
      new Set(body.activities).size,
      body.activities.length,
      'activities should be de-duplicated across facilities',
    )
  })

  test('rejects a non-numeric capacity filter instead of ignoring it', async () => {
    const response = await apiRequest(server, '/api/facilities?minCapacity=abc', {
      cookie: student.cookie,
    })

    assert.equal(response.status, 400)
    assert.equal(codeOf(response), 'VALIDATION_FAILED')
  })

  test('returns 404 for an unknown facility, and for an unknown route, as JSON', async () => {
    const missing = await apiRequest(server, '/api/facilities/does-not-exist', {
      cookie: student.cookie,
    })
    assert.equal(missing.status, 404)
    assert.equal(codeOf(missing), 'NOT_FOUND')

    const unknownRoute = await apiRequest(server, '/api/nope', { cookie: student.cookie })
    assert.equal(unknownRoute.status, 404)
    assert.equal(codeOf(unknownRoute), 'NOT_FOUND')
  })
})

describe('availability', () => {
  test('shows a booked interval as busy and does not offer it as free', async () => {
    const date = allocateOpenDate(lectureHallA)

    const created = await apiRequest(server, '/api/bookings', {
      method: 'POST',
      cookie: rep.cookie,
      body: bookingBody({ date, startTime: '09:00', endTime: '11:00' }),
    })
    assert.equal(created.status, 201)

    const response = await apiRequest(
      server,
      `/api/facilities/${lectureHallA.id}/availability?date=${date}`,
      { cookie: student.cookie },
    )

    assert.equal(response.status, 200)
    const availability = (
      response.body as {
        availability: {
          busy: Array<{ startTime: string; endTime: string; activityPurpose: string }>
          freeSlots: Array<{ startTime: string; endTime: string }>
          closedReason: string | null
        }
      }
    ).availability

    assert.equal(availability.closedReason, null)
    assert.equal(availability.busy.length, 1)
    assert.equal(availability.busy[0]?.activityPurpose, 'Revision session')

    // No free slot may cover the booked window. This is the property that
    // matters - the exact partition of the day is an implementation detail.
    const busyStart = new Date(availability.busy[0]?.startTime ?? '').getTime()
    const busyEnd = new Date(availability.busy[0]?.endTime ?? '').getTime()

    for (const slot of availability.freeSlots) {
      const start = new Date(slot.startTime).getTime()
      const end = new Date(slot.endTime).getTime()
      const overlaps = start < busyEnd && end > busyStart
      assert.ok(!overlaps, `free slot ${slot.startTime}-${slot.endTime} overlaps the booking`)
    }
  })

  test('does not disclose who booked the facility', async () => {
    const date = allocateOpenDate(lectureHallA)

    await apiRequest(server, '/api/bookings', {
      method: 'POST',
      cookie: rep.cookie,
      body: bookingBody({ date, startTime: '14:00', endTime: '15:00' }),
    })

    const response = await apiRequest(
      server,
      `/api/facilities/${lectureHallA.id}/availability?date=${date}`,
      { cookie: student.cookie },
    )

    const availability = (
      response.body as { availability: { busy: Array<Record<string, unknown>> } }
    ).availability

    assert.equal(availability.busy.length, 1)
    const serialised = JSON.stringify(availability.busy[0])

    // The person's name and id must not appear anywhere in the payload.
    assert.ok(!serialised.includes('Brian'), 'availability leaked the booker name')
    assert.ok(!serialised.includes(rep.user.id), 'availability leaked the booker id')
  })
})

describe('authorization on the booking route', () => {
  test('refuses a student', async () => {
    const response = await apiRequest(server, '/api/bookings', {
      method: 'POST',
      cookie: student.cookie,
      body: bookingBody(),
    })

    assert.equal(response.status, 403)
    assert.equal(codeOf(response), 'FORBIDDEN')
  })

  // There is deliberately no "refuses an anonymous caller" test any more. There
  // is no anonymous caller: a request with no cookie acts as the default
  // representative, which the identity block above asserts directly. The guard
  // that mattered - a student is refused - is the test above, and it still holds
  // because the role comes from the profile rather than from the interface.
  test('does not expose another representative’s booking by id', async () => {
    const created = await apiRequest(server, '/api/bookings', {
      method: 'POST',
      cookie: rep.cookie,
      body: bookingBody(),
    })

    const bookingId = (created.body as { booking: { id: string } }).booking.id

    const asOwner = await apiRequest(server, `/api/bookings/${bookingId}`, { cookie: rep.cookie })
    assert.equal(asOwner.status, 200)

    // Reported as missing rather than forbidden, so the response does not
    // confirm that an id the caller guessed corresponds to a real booking.
    const asOther = await apiRequest(server, `/api/bookings/${bookingId}`, { cookie: rep2.cookie })
    assert.equal(asOther.status, 404)
    assert.equal(codeOf(asOther), 'NOT_FOUND')

    const adminSession = await actAs('user-admin')
    const asAdmin = await apiRequest(server, `/api/bookings/${bookingId}`, {
      cookie: adminSession.cookie,
    })
    assert.equal(asAdmin.status, 200)
  })

  test('lists a representative’s own upcoming bookings', async () => {
    const response = await apiRequest(server, '/api/bookings/mine?scope=upcoming', {
      cookie: rep.cookie,
    })

    assert.equal(response.status, 200)
    const body = response.body as {
      bookings: Array<{ bookedById: string; status: string }>
      scope: string
    }

    assert.equal(body.scope, 'upcoming')
    assert.ok(body.bookings.length > 0)
    assert.ok(body.bookings.every((booking) => booking.bookedById === rep.user.id))
    assert.ok(body.bookings.every((booking) => booking.status === 'confirmed'))
  })

  test('rejects an unrecognised scope with a clear message', async () => {
    const response = await apiRequest(server, '/api/bookings/mine?scope=whenever', {
      cookie: rep.cookie,
    })

    assert.equal(response.status, 400)
    assert.equal(codeOf(response), 'VALIDATION_FAILED')
  })
})

describe('cancellation over HTTP', () => {
  test('cancels, then refuses to cancel again', async () => {
    const date = allocateOpenDate(lectureHallA)

    const created = await apiRequest(server, '/api/bookings', {
      method: 'POST',
      cookie: rep.cookie,
      body: bookingBody({ date, startTime: '16:00', endTime: '17:00' }),
    })

    const bookingId = (created.body as { booking: { id: string } }).booking.id

    const cancelled = await apiRequest(server, `/api/bookings/${bookingId}/cancel`, {
      method: 'POST',
      cookie: rep.cookie,
      body: { reason: 'Class moved' },
    })

    assert.equal(cancelled.status, 200)
    assert.equal((cancelled.body as { booking: { status: string } }).booking.status, 'cancelled')

    const again = await apiRequest(server, `/api/bookings/${bookingId}/cancel`, {
      method: 'POST',
      cookie: rep.cookie,
      body: {},
    })

    assert.equal(again.status, 409)
    assert.equal(codeOf(again), 'CANCELLATION_NOT_PERMITTED')
  })
})

describe('recommendations', () => {
  const request = {
    activityPurpose: 'Revision session',
    expectedAttendance: 30,
    startTime: '09:00',
    endTime: '10:00',
  }

  test('offers bookable facilities to a representative, each with a reason', async () => {
    const response = await apiRequest(server, '/api/bookings/recommendations', {
      method: 'POST',
      cookie: rep.cookie,
      body: { ...request, date: allocateOpenDate(lectureHallA) },
    })

    assert.equal(response.status, 200)
    const result = (
      response.body as {
        result: {
          recommendations: Array<{ score: number; reasons: string[] }>
          rejected: Array<{ reason: string }>
          consideredCount: number
        }
      }
    ).result

    assert.ok(result.consideredCount > 0)
    assert.ok(result.recommendations.length > 0, 'a free slot should produce recommendations')

    for (const recommendation of result.recommendations) {
      assert.ok(recommendation.reasons.length > 0, 'every recommendation must explain itself')
    }

    // Ranked, strongest first.
    const scores = result.recommendations.map((item) => item.score)
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a))
  })

  test('tells a student why facilities are out of reach rather than claiming none exist', async () => {
    const response = await apiRequest(server, '/api/bookings/recommendations', {
      method: 'POST',
      cookie: student.cookie,
      body: { ...request, date: allocateOpenDate(lectureHallA) },
    })

    assert.equal(response.status, 200)
    const result = (
      response.body as {
        result: {
          recommendations: unknown[]
          rejected: Array<{ code: string; reason: string }>
        }
      }
    ).result

    assert.equal(result.recommendations.length, 0)
    assert.ok(result.rejected.length > 0)
    assert.ok(
      result.rejected.every((item) => item.reason.length > 0),
      'each rejection must carry a reason',
    )
  })

  test('never suggests a facility that the booking route would then refuse', async () => {
    const date = allocateOpenDate(lectureHallA)

    const response = await apiRequest(server, '/api/bookings/recommendations', {
      method: 'POST',
      cookie: rep.cookie,
      body: { ...request, date },
    })

    const result = (
      response.body as { result: { recommendations: Array<{ facility: { id: string } }> } }
    ).result

    assert.ok(result.recommendations.length > 0)

    // The claim being tested: a recommended slot is bookable. Each facility
    // offered is booked for exactly the window that was recommended, at the
    // same date. Every one must be accepted, or the engine has drifted from the
    // rules the booking path enforces - which is the failure this whole design
    // exists to prevent.
    for (const recommendation of result.recommendations) {
      const outcome = await apiRequest(server, '/api/bookings', {
        method: 'POST',
        cookie: rep.cookie,
        body: {
          facilityId: recommendation.facility.id,
          activityPurpose: request.activityPurpose,
          expectedAttendance: request.expectedAttendance,
          date,
          startTime: request.startTime,
          endTime: request.endTime,
        },
      })

      assert.equal(
        outcome.status,
        201,
        `${recommendation.facility.id} was recommended but booking it returned ${outcome.status}: ` +
          JSON.stringify(outcome.body),
      )
    }
  })
})

describe('concurrency', () => {
  test('confirms exactly one of eight simultaneous requests for the same slot', async () => {
    const date = allocateOpenDate(lectureHallA)

    const body = {
      facilityId: lectureHallA.id,
      activityPurpose: 'Revision session',
      expectedAttendance: 50,
      date,
      startTime: '11:00',
      endTime: '12:00',
    }

    // Two different representatives, four attempts each, all issued at once.
    // This is the scenario the brief describes: two class representatives
    // trying to take the same room at the same moment.
    const attempts = Array.from({ length: 8 }, (_unused, index) =>
      apiRequest(server, '/api/bookings', {
        method: 'POST',
        cookie: index % 2 === 0 ? rep.cookie : rep2.cookie,
        body,
      }),
    )

    const responses = await Promise.all(attempts)
    const statuses = responses.map((response) => response.status)

    const confirmed = statuses.filter((status) => status === 201)
    const conflicted = statuses.filter((status) => status === 409)

    assert.equal(
      confirmed.length,
      1,
      `expected exactly one confirmation, got ${confirmed.length}. Statuses: ${statuses.join(', ')}`,
    )
    assert.equal(
      conflicted.length,
      7,
      `expected seven conflicts, got ${conflicted.length}. Statuses: ${statuses.join(', ')}`,
    )

    // Every rejection must be a genuine conflict, not an unrelated error. This
    // is the assertion that covers the race path: a loser rejected by the
    // exclusion constraint rather than by the pre-check must still arrive as
    // CONFLICT, not as INTERNAL_ERROR.
    for (const response of responses) {
      if (response.status === 409) {
        assert.equal(
          codeOf(response),
          'CONFLICT',
          `a rejected request should be reported as CONFLICT, got ${JSON.stringify(response.body)}`,
        )
      }
    }

    // And the database agrees with the API: one row, not eight.
    const slotStart = combineLocalDateTimeToUtc(date, '11:00')
    const rows = await queryOne<{ n: number }>(
      `select count(*)::int as n from bookings
        where facility_id = @facilityId and start_time = @startTime and status = 'confirmed'`,
      { facilityId: lectureHallA.id, startTime: slotStart },
    )

    assert.equal(rows?.n, 1, 'exactly one confirmed booking should exist for the slot')
  })
})
