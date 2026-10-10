/**
 * API-level tests: the whole request path, over real HTTP.
 *
 * ===========================================================================
 * WHY THESE EXIST ALONGSIDE THE SERVICE TESTS
 * ===========================================================================
 *
 * booking.test.ts calls the booking service directly, which proves the rules.
 * These tests prove the rules are actually reachable through the API and that
 * the guards in front of them hold: session resolution, the role gates on the
 * routes, the error shape the client parses, and the fact that a student
 * reaching the endpoint by hand still gets nothing.
 *
 * The concurrency test lives here rather than in the service tests because the
 * guarantee being claimed is about the SERVER: eight simultaneous HTTP requests,
 * one slot, exactly one confirmation. Anything less end-to-end would not be
 * evidence for that claim.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import './env.ts'
import { DEMO_PASSWORD } from '../db/seed.ts'
import { getDb } from '../db/connection.ts'
import { getFacilityOrThrow } from '../services/facilityService.ts'
import {
  allocateOpenDate,
  apiRequest,
  errorCode,
  prepareTestDatabase,
  sessionCookieFrom,
  signInAs,
  startTestServer,
  type HttpResponse,
  type TestServer,
} from './harness.ts'

prepareTestDatabase()

const lectureHallA = getFacilityOrThrow('fac-lecture-hall-a')

const rep = signInAs('user-rep-brian')
const rep2 = signInAs('user-rep-cynthia')
const student = signInAs('user-student')

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

describe('authentication', () => {
  test('serves a health check without a session', async () => {
    const response = await apiRequest(server, '/api/health')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: 'ok', service: 'eduvenue-api' })
  })

  test('refuses to list facilities without a session', async () => {
    const response = await apiRequest(server, '/api/facilities')

    assert.equal(response.status, 401)
    assert.equal(codeOf(response), 'UNAUTHENTICATED')
  })

  test('signs in with a demo account and resolves the session on later requests', async () => {
    const login = await apiRequest(server, '/api/auth/login', {
      method: 'POST',
      body: { email: 'rep.brian@eduvenue.test', password: DEMO_PASSWORD },
    })

    assert.equal(login.status, 200)

    const cookie = sessionCookieFrom(login)
    assert.match(cookie, /^eduvenue_session=/, 'a session cookie should be set')

    const me = await apiRequest(server, '/api/auth/me', { cookie })

    assert.equal(me.status, 200)
    const body = me.body as { user: { email: string; role: string } }
    assert.equal(body.user.email, 'rep.brian@eduvenue.test')
    assert.equal(body.user.role, 'rep')
  })

  test('gives the same answer for an unknown account and a wrong password', async () => {
    const unknown = await apiRequest(server, '/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@eduvenue.test', password: DEMO_PASSWORD },
    })

    const wrongPassword = await apiRequest(server, '/api/auth/login', {
      method: 'POST',
      body: { email: 'rep.brian@eduvenue.test', password: 'not-the-password' },
    })

    assert.equal(unknown.status, 401)
    assert.equal(wrongPassword.status, 401)

    // Identical wording, so the response cannot be used to discover which
    // addresses have accounts.
    assert.deepEqual(unknown.body, wrongPassword.body)
  })

  test('revokes the session on sign-out', async () => {
    const login = await apiRequest(server, '/api/auth/login', {
      method: 'POST',
      body: { email: 'rep.brian@eduvenue.test', password: DEMO_PASSWORD },
    })

    const cookie = sessionCookieFrom(login)

    const logout = await apiRequest(server, '/api/auth/logout', { method: 'POST', cookie })
    assert.equal(logout.status, 204)

    // The same cookie is now worthless.
    const after = await apiRequest(server, '/api/auth/me', { cookie })
    assert.equal(after.status, 200)
    assert.deepEqual(after.body, { user: null })

    const protectedCall = await apiRequest(server, '/api/facilities', { cookie })
    assert.equal(protectedCall.status, 401)
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
    const studentIds = (asStudent.body as { facilities: Array<{ id: string }> }).facilities.map((f) => f.id)
    assert.ok(!studentIds.includes(withdrawnId))

    // A non-administrator asking for inactive facilities is quietly given the
    // normal active list, and the response says so in `filters`.
    const studentAsking = await apiRequest(server, '/api/facilities?includeInactive=true', {
      cookie: student.cookie,
    })
    const studentFilters = (studentAsking.body as { filters: { includeInactive: boolean } }).filters
    assert.equal(studentFilters.includeInactive, false)

    const admin = signInAs('user-admin')
    const adminAsking = await apiRequest(server, '/api/facilities?includeInactive=true', {
      cookie: admin.cookie,
    })

    const adminIds = (adminAsking.body as { facilities: Array<{ id: string }> }).facilities.map((f) => f.id)
    assert.ok(adminIds.includes(withdrawnId), 'an administrator should be able to see withdrawn facilities')
  })

  test('filters by category and by minimum capacity', async () => {
    const computing = await apiRequest(server, '/api/facilities?categoryId=cat-computing', {
      cookie: student.cookie,
    })
    const computingBody = computing.body as { facilities: Array<{ categoryId: string }> }
    assert.ok(computingBody.facilities.length > 0)
    assert.ok(computingBody.facilities.every((facility) => facility.categoryId === 'cat-computing'))

    const large = await apiRequest(server, '/api/facilities?minCapacity=100', { cookie: student.cookie })
    const largeBody = large.body as { facilities: Array<{ capacity: number }> }
    assert.ok(largeBody.facilities.every((facility) => facility.capacity >= 100))
  })

  test('treats a wildcard in a search term as a literal character', async () => {
    // A search for "%" must not return the whole directory. If the value were
    // interpolated into the LIKE pattern unescaped, it would match everything.
    const response = await apiRequest(server, '/api/facilities?q=%25', { cookie: student.cookie })

    assert.equal(response.status, 200)
    const body = response.body as { count: number }
    assert.equal(body.count, 0)
  })

  test('rejects a non-numeric capacity filter instead of ignoring it', async () => {
    const response = await apiRequest(server, '/api/facilities?minCapacity=abc', { cookie: student.cookie })

    assert.equal(response.status, 400)
    assert.equal(codeOf(response), 'VALIDATION_FAILED')
  })

  test('returns 404 for an unknown facility, and for an unknown route, as JSON', async () => {
    const missing = await apiRequest(server, '/api/facilities/does-not-exist', { cookie: student.cookie })
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

    const response = await apiRequest(server, `/api/facilities/${lectureHallA.id}/availability?date=${date}`, {
      cookie: student.cookie,
    })

    assert.equal(response.status, 200)
    const availability = (response.body as {
      availability: {
        busy: Array<{ startTime: string; endTime: string; activityPurpose: string }>
        freeSlots: Array<{ startTime: string; endTime: string }>
        closedReason: string | null
      }
    }).availability

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

    const response = await apiRequest(server, `/api/facilities/${lectureHallA.id}/availability?date=${date}`, {
      cookie: student.cookie,
    })

    const availability = (response.body as { availability: { busy: Array<Record<string, unknown>> } })
      .availability

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

  test('refuses an anonymous caller', async () => {
    const response = await apiRequest(server, '/api/bookings', {
      method: 'POST',
      body: bookingBody(),
    })

    assert.equal(response.status, 401)
    assert.equal(codeOf(response), 'UNAUTHENTICATED')
  })

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

    const asAdmin = await apiRequest(server, `/api/bookings/${bookingId}`, {
      cookie: signInAs('user-admin').cookie,
    })
    assert.equal(asAdmin.status, 200)
  })

  test('lists a representative’s own upcoming bookings', async () => {
    const response = await apiRequest(server, '/api/bookings/mine?scope=upcoming', { cookie: rep.cookie })

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
    const response = await apiRequest(server, '/api/bookings/mine?scope=whenever', { cookie: rep.cookie })

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
    const result = (response.body as {
      result: {
        recommendations: Array<{ score: number; reasons: string[] }>
        rejected: Array<{ reason: string }>
        consideredCount: number
      }
    }).result

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
    const result = (response.body as {
      result: {
        recommendations: unknown[]
        rejected: Array<{ code: string; reason: string }>
      }
    }).result

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

    const result = (response.body as { result: { recommendations: Array<{ facility: { id: string } }> } })
      .result

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
    assert.equal(conflicted.length, 7, `expected seven conflicts, got ${conflicted.length}`)

    // Every rejection must be a genuine conflict, not an unrelated error.
    for (const response of responses) {
      if (response.status === 409) {
        assert.equal(codeOf(response), 'CONFLICT')
      }
    }

    // And the database agrees with the API: one row, not eight.
    const rows = getDb()
      .prepare(
        `select count(*) as n from bookings
          where facility_id = ? and start_time = ? and status = 'confirmed'`,
      )
      .get(lectureHallA.id, new Date(`${date}T11:00:00+03:00`).toISOString()) as { n: number }

    assert.equal(rows.n, 1, 'exactly one confirmed booking should exist for the slot')
  })
})
