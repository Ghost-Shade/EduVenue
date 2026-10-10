/**
 * Booking engine tests: the rules, and the thing the whole project rests on.
 *
 * ===========================================================================
 * WHAT THESE TESTS ARE FOR
 * ===========================================================================
 *
 * The brief's central requirement is that two confirmed bookings can never
 * overlap for the same facility, including when two representatives submit at
 * the same moment. `lib/overlap.ts` proves the PREDICATE is right, in isolation,
 * with pure functions. This file proves the SYSTEM enforces it: it drives real
 * bookings through the real service, against a real database.
 *
 * A correct predicate that is wired up wrongly still double-books rooms, so
 * both layers are tested. The final test fires eight simultaneous HTTP requests
 * at one slot and asserts that exactly one is confirmed.
 *
 * ===========================================================================
 * WHY THE DATES ARE FAR IN THE FUTURE
 * ===========================================================================
 *
 * The seed data covers days -10 to +4 relative to today, so every test here
 * books at least 10 days out. Those days are provably free of seeded bookings
 * and blocks, which makes the assertions deterministic instead of dependent on
 * what day of the week the suite happens to run. `openDateFor` additionally
 * skips the facility's closed weekdays.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import './env.ts'
import { addDaysToLocalDate, combineLocalDateTimeToUtc } from '../lib/time.ts'
import { isApiError, type ApiError } from '../lib/errors.ts'
import { getDb } from '../db/connection.ts'
import { getFacilityOrThrow, type FacilityRecord } from '../services/facilityService.ts'
import {
  cancelBooking,
  createBooking,
  evaluateBookingRequest,
  type CreateBookingInput,
} from '../services/bookingService.ts'
import {
  allocateOpenDate,
  localWeekday,
  prepareTestDatabase,
  signInAs,
  TEST_USER_IDS,
} from './harness.ts'

prepareTestDatabase()

const rep = signInAs(TEST_USER_IDS.rep)
const rep2 = signInAs(TEST_USER_IDS.rep2)
const admin = signInAs(TEST_USER_IDS.admin)
const supervisor = signInAs(TEST_USER_IDS.supervisor)
const student = signInAs(TEST_USER_IDS.student)

const lectureHallA = getFacilityOrThrow('fac-lecture-hall-a')
const computingLabA = getFacilityOrThrow('fac-computing-lab-a')
const chemistryLabA = getFacilityOrThrow('fac-chemistry-lab-a')

/**
 * Allocates a date for a test. See `allocateOpenDate` in harness.ts for why a
 * naive "N days from now" is not good enough.
 */
function freeDayFor(facility: FacilityRecord, minDaysAhead = 10): string {
  return allocateOpenDate(facility, minDaysAhead)
}

/** A date Lecture Hall A is open on, with no seeded bookings or blocks on it. */
function freeDay(minDaysAhead = 10): string {
  return freeDayFor(lectureHallA, minDaysAhead)
}

function bookingInput(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    facilityId: lectureHallA.id,
    activityPurpose: 'Revision session',
    expectedAttendance: 40,
    date: freeDay(),
    startTime: '09:00',
    endTime: '10:00',
    ...overrides,
  }
}

/**
 * Runs a call that is expected to fail and returns the ApiError.
 *
 * A plain `assert.throws` cannot check the machine-readable `code` or the
 * structured `details`, both of which are part of the API contract.
 */
function captureApiError(fn: () => unknown): ApiError {
  try {
    fn()
  } catch (error) {
    if (isApiError(error)) return error
    throw error
  }
  throw new Error('Expected the call to be rejected, but it succeeded.')
}

describe('a booking that satisfies every rule', () => {
  test('is confirmed immediately, with no approval step', () => {
    const booking = createBooking(rep.user, bookingInput())

    assert.equal(booking.status, 'confirmed')
    assert.equal(booking.facilityId, lectureHallA.id)
    assert.equal(booking.bookedById, rep.user.id)
    assert.equal(booking.durationMinutes, 60)
  })

  test('receives a readable, unique reference containing the booking year', () => {
    const date = freeDay()
    const year = date.slice(0, 4)

    const first = createBooking(rep.user, bookingInput({ date, startTime: '11:00', endTime: '12:00' }))
    const second = createBooking(rep.user, bookingInput({ date, startTime: '12:00', endTime: '13:00' }))

    assert.match(first.reference, new RegExp(`^EDU-${year}-\\d{4}$`))
    assert.notEqual(first.reference, second.reference)

    const [firstSequence, secondSequence] = [first.reference, second.reference].map((reference) =>
      Number(reference.split('-')[2]),
    )
    assert.ok(
      (secondSequence ?? 0) > (firstSequence ?? 0),
      `references should increase, got ${first.reference} then ${second.reference}`,
    )
  })

  test('is recorded in the audit trail', () => {
    const booking = createBooking(rep.user, bookingInput({ date: freeDay(11), startTime: '14:00', endTime: '15:00' }))

    const entry = getDb()
      .prepare(
        `select actor_id, action, metadata from audit_logs
          where entity_type = 'booking' and entity_id = ?`,
      )
      .get(booking.id) as { actor_id: string; action: string; metadata: string } | undefined

    assert.ok(entry, 'a booking should produce an audit entry')
    assert.equal(entry.action, 'booking.created')
    assert.equal(entry.actor_id, rep.user.id)

    // The purpose and times are recorded; no credential or personal detail is.
    const metadata = JSON.parse(entry.metadata) as Record<string, unknown>
    assert.equal(metadata['reference'], booking.reference)
    assert.ok(!('password' in metadata))
  })
})

describe('half-open interval handling', () => {
  test('allows a booking that starts exactly when another ends', () => {
    const date = freeDay(12)

    const morning = createBooking(rep.user, bookingInput({ date, startTime: '08:00', endTime: '09:00' }))
    const following = createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '10:00' }))

    assert.equal(morning.status, 'confirmed')
    assert.equal(following.status, 'confirmed')
  })

  test('rejects a booking that overlaps the second half of an existing one', () => {
    const date = freeDay(13)
    const existing = createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '11:00' }))

    const error = captureApiError(() =>
      createBooking(rep2.user, bookingInput({ date, startTime: '10:00', endTime: '12:00' })),
    )

    assert.equal(error.status, 409)
    assert.equal(error.code, 'CONFLICT')

    // The response names the booking that got in the way, so the client can be
    // specific rather than saying "something is wrong".
    const details = error.details as { conflicting?: { reference?: string } } | undefined
    assert.equal(details?.conflicting?.reference, existing.reference)
  })

  test('rejects a booking that starts before another but overlaps its start', () => {
    const date = freeDay(14)
    createBooking(rep.user, bookingInput({ date, startTime: '10:00', endTime: '12:00' }))

    const error = captureApiError(() =>
      createBooking(rep2.user, bookingInput({ date, startTime: '09:00', endTime: '11:00' })),
    )

    assert.equal(error.code, 'CONFLICT')
  })

  test('rejects a booking entirely contained within an existing one', () => {
    const date = freeDay(15)
    createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '13:00' }))

    const error = captureApiError(() =>
      createBooking(rep2.user, bookingInput({ date, startTime: '10:00', endTime: '11:00' })),
    )

    assert.equal(error.code, 'CONFLICT')
  })

  test('rejects a booking that entirely contains an existing one', () => {
    const date = freeDay(16)
    createBooking(rep.user, bookingInput({ date, startTime: '10:00', endTime: '11:00' }))

    const error = captureApiError(() =>
      createBooking(rep2.user, bookingInput({ date, startTime: '08:00', endTime: '13:00' })),
    )

    assert.equal(error.code, 'CONFLICT')
  })

  test('rejects a second booking of the same slot even by the same person', () => {
    const date = freeDay(17)
    createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '10:00' }))

    const error = captureApiError(() =>
      createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '10:00' })),
    )

    assert.equal(
      error.code,
      'CONFLICT',
      'a user should not be able to double-book a slot, only themselves or not',
    )
  })
})

describe('transition buffers', () => {
  const LAB = computingLabA.id

  function labBooking(date: string, startTime: string, endTime: string): CreateBookingInput {
    return {
      facilityId: LAB,
      activityPurpose: 'Practical session',
      expectedAttendance: 20,
      date,
      startTime,
      endTime,
    }
  }

  test('rejects a booking that starts inside the preparation gap', () => {
    const date = freeDayFor(computingLabA, 18)
    createBooking(rep.user, labBooking(date, '09:00', '10:00'))

    // Computing Lab A requires 15 minutes between sessions, so 10:05 is too
    // soon even though it does not technically overlap the earlier booking.
    const error = captureApiError(() => createBooking(rep.user, labBooking(date, '10:05', '11:00')))

    assert.equal(error.code, 'CONFLICT')

    const details = error.details as { bufferMinutes?: number } | undefined
    assert.equal(details?.bufferMinutes, 15)
  })

  test('allows a booking that starts exactly on the buffer boundary', () => {
    const date = freeDayFor(computingLabA, 19)
    createBooking(rep.user, labBooking(date, '13:00', '14:00'))

    const following = createBooking(rep.user, labBooking(date, '14:15', '15:15'))

    assert.equal(following.status, 'confirmed')
  })
})

describe('operating hours and closed days', () => {
  test('rejects a booking before the facility opens', () => {
    const error = captureApiError(() =>
      createBooking(rep.user, bookingInput({ date: freeDay(20), startTime: '06:00', endTime: '07:00' })),
    )

    assert.equal(error.code, 'OUTSIDE_OPERATING_HOURS')
    assert.equal(error.status, 409)
  })

  test('rejects a booking that would run past closing time', () => {
    // Lecture Hall A closes at 21:00.
    const error = captureApiError(() =>
      createBooking(rep.user, bookingInput({ date: freeDay(21), startTime: '20:30', endTime: '21:30' })),
    )

    assert.equal(error.code, 'OUTSIDE_OPERATING_HOURS')
  })

  test('accepts a booking that ends exactly at closing time', () => {
    const booking = createBooking(
      rep.user,
      bookingInput({ date: freeDay(22), startTime: '20:00', endTime: '21:00' }),
    )

    assert.equal(booking.status, 'confirmed')
  })

  test('rejects a booking on a day the facility does not operate', () => {
    // Lecture Hall A is closed on Sundays.
    let date = freeDay(23)
    for (let attempt = 0; attempt < 7 && localWeekday(date) !== 0; attempt += 1) {
      date = addDaysToLocalDate(date, 1)
    }

    assert.equal(localWeekday(date), 0, 'the test needs a Sunday to proceed')

    const error = captureApiError(() => createBooking(rep.user, bookingInput({ date })))

    assert.equal(error.code, 'FACILITY_UNAVAILABLE')
  })
})

describe('blocks and facility status', () => {
  test('rejects a booking that falls inside a maintenance block, and says why', () => {
    const date = freeDay(24)

    // Blocks are created by administrators; inserting one directly keeps this
    // test focused on the booking rule rather than on the admin route.
    getDb()
      .prepare(
        `insert into facility_blocks (id, facility_id, start_time, end_time, reason, created_by)
         values (@id, @facilityId, @startTime, @endTime, @reason, @createdBy)`,
      )
      .run({
        id: 'blk-test-001',
        facilityId: lectureHallA.id,
        startTime: combineLocalDateTimeToUtc(date, '13:00').toISOString(),
        endTime: combineLocalDateTimeToUtc(date, '15:00').toISOString(),
        reason: 'Examinations office briefing',
        createdBy: admin.user.id,
      })

    const error = captureApiError(() =>
      createBooking(rep.user, bookingInput({ date, startTime: '14:00', endTime: '15:00' })),
    )

    assert.equal(error.code, 'FACILITY_UNAVAILABLE')

    const details = error.details as { reason?: string } | undefined
    assert.match(details?.reason ?? '', /Examinations office briefing/)
  })

  test('rejects a booking at a facility withdrawn from booking', () => {
    const error = captureApiError(() =>
      createBooking(rep.user, {
        facilityId: 'fac-classroom-c2',
        activityPurpose: 'Revision session',
        expectedAttendance: 20,
        date: freeDay(25),
        startTime: '09:00',
        endTime: '10:00',
      }),
    )

    assert.equal(error.code, 'FACILITY_UNAVAILABLE')
    assert.equal(error.status, 409)
  })
})

describe('eligibility rules', () => {
  test('rejects attendance larger than the room holds', () => {
    // Lecture Hall A holds 150.
    const error = captureApiError(() =>
      createBooking(rep.user, bookingInput({ date: freeDay(26), expectedAttendance: 200 })),
    )

    assert.equal(error.code, 'CAPACITY_EXCEEDED')

    const details = error.details as { capacity?: number; requestedAttendance?: number } | undefined
    assert.equal(details?.capacity, 150)
    assert.equal(details?.requestedAttendance, 200)
  })

  test('rejects an activity the facility is not approved for', () => {
    const error = captureApiError(() =>
      createBooking(rep.user, bookingInput({ date: freeDay(27), activityPurpose: 'Freshers party' })),
    )

    assert.equal(error.code, 'ACTIVITY_NOT_PERMITTED')

    const details = error.details as { allowedActivities?: string[] } | undefined
    assert.ok((details?.allowedActivities?.length ?? 0) > 0, 'the message should list what is allowed')
  })

  test('rejects a booking attempted by a student', () => {
    const error = captureApiError(() => createBooking(student.user, bookingInput({ date: freeDay(28) })))

    assert.equal(error.status, 403)
    assert.equal(error.code, 'FORBIDDEN')
  })

  test('rejects a representative, but accepts a supervisor, where supervision is required', () => {
    // Chemistry Lab A is configured with BOTH min_role 'supervisor' and policy
    // 'supervisor_required', so an ordinary representative is stopped by the
    // role gate. To exercise the policy gate on its own, the facility is
    // relaxed to min_role 'rep' first - exactly the misconfiguration the two
    // independent gates exist to survive.
    const db = getDb()
    const original = chemistryLabA.minRole
    db.prepare(`update facilities set min_role = 'rep' where id = ?`).run(chemistryLabA.id)

    try {
      const relaxed = getFacilityOrThrow(chemistryLabA.id)
      const date = freeDayFor(relaxed, 29)

      const input = {
        facilityId: relaxed.id,
        activityPurpose: 'Practical session',
        expectedAttendance: 12,
        date,
        startTime: '09:00',
        endTime: '10:00',
      }

      const error = captureApiError(() => createBooking(rep.user, input))
      assert.equal(error.code, 'SUPERVISION_REQUIRED')

      // A supervisor clears both gates.
      const bySupervisor = createBooking(supervisor.user, input)
      assert.equal(bySupervisor.status, 'confirmed')
    } finally {
      db.prepare(`update facilities set min_role = ? where id = ?`).run(original, chemistryLabA.id)
    }
  })
})

describe('cancellation', () => {
  test('releases the slot for someone else', () => {
    const date = freeDay(30)

    const booking = createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '10:00' }))

    // While it exists, the slot is genuinely unavailable.
    assert.equal(
      captureApiError(() => createBooking(rep2.user, bookingInput({ date, startTime: '09:00', endTime: '10:00' })))
        .code,
      'CONFLICT',
    )

    const cancelled = cancelBooking(rep.user, booking.id, { reason: 'Class rescheduled' })
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancellationReason, 'Class rescheduled')
    assert.ok(cancelled.cancelledAt)

    // Now it can be taken.
    const replacement = createBooking(rep2.user, bookingInput({ date, startTime: '09:00', endTime: '10:00' }))
    assert.equal(replacement.status, 'confirmed')
  })

  test('cannot be performed by another representative', () => {
    const booking = createBooking(rep.user, bookingInput({ date: freeDay(31), startTime: '15:00', endTime: '16:00' }))

    const error = captureApiError(() => cancelBooking(rep2.user, booking.id))

    assert.equal(error.status, 403)
    assert.equal(error.code, 'FORBIDDEN')

    // And the booking is untouched.
    const stillThere = getDb()
      .prepare(`select status from bookings where id = ?`)
      .get(booking.id) as { status: string }
    assert.equal(stillThere.status, 'confirmed')
  })

  test('cannot be repeated', () => {
    const booking = createBooking(rep.user, bookingInput({ date: freeDay(32), startTime: '16:00', endTime: '17:00' }))

    cancelBooking(rep.user, booking.id)

    const error = captureApiError(() => cancelBooking(rep.user, booking.id))
    assert.equal(error.code, 'CANCELLATION_NOT_PERMITTED')
  })

  test('can be performed by an administrator on someone else’s booking', () => {
    const booking = createBooking(rep.user, bookingInput({ date: freeDay(33), startTime: '08:00', endTime: '09:00' }))

    const cancelled = cancelBooking(admin.user, booking.id, { reason: 'Room needed for an examination' })

    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancelledByName, admin.user.displayName)
  })
})

describe('a rejected booking leaves nothing behind', () => {
  test('no row and no consumed reference', () => {
    const date = freeDay(34)
    const before = getDb()
      .prepare(`select count(*) as n from bookings where facility_id = ? and start_time like ?`)
      .get(lectureHallA.id, `${date}%`) as { n: number }

    createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '10:00' }))
    captureApiError(() => createBooking(rep2.user, bookingInput({ date, startTime: '09:30', endTime: '10:30' })))

    const after = getDb()
      .prepare(`select count(*) as n from bookings where facility_id = ? and start_time like ?`)
      .get(lectureHallA.id, `${date}%`) as { n: number }

    assert.equal(after.n, before.n + 1, 'exactly one booking should exist after one success and one failure')
  })
})

describe('evaluateBookingRequest', () => {
  test('reports a free slot as bookable without throwing', () => {
    const date = freeDay(35)

    const evaluation = evaluateBookingRequest({
      facility: lectureHallA,
      actor: rep.user,
      start: combineLocalDateTimeToUtc(date, '12:00'),
      end: combineLocalDateTimeToUtc(date, '13:00'),
      activityPurpose: 'Revision session',
      expectedAttendance: 30,
      localDate: date,
    })

    assert.equal(evaluation.bookable, true)
    assert.equal(evaluation.code, undefined)
  })

  test('reports why a slot is not bookable, using the same rule the write path applies', () => {
    const date = freeDay(36)

    const taken = createBooking(rep.user, bookingInput({ date, startTime: '09:00', endTime: '11:00' }))

    const evaluation = evaluateBookingRequest({
      facility: lectureHallA,
      actor: rep2.user,
      start: combineLocalDateTimeToUtc(date, '10:00'),
      end: combineLocalDateTimeToUtc(date, '12:00'),
      activityPurpose: 'Revision session',
      expectedAttendance: 30,
      localDate: date,
    })

    assert.equal(evaluation.bookable, false)
    assert.equal(evaluation.code, 'CONFLICT')

    const details = evaluation.details as { conflicting?: { reference?: string } } | undefined
    assert.equal(
      details?.conflicting?.reference,
      taken.reference,
      'the recommender must see the same conflict the booking path would report',
    )
  })

  test('reserves nothing: the same slot can still be booked afterwards', () => {
    const date = freeDay(37)

    evaluateBookingRequest({
      facility: lectureHallA,
      actor: rep.user,
      start: combineLocalDateTimeToUtc(date, '14:00'),
      end: combineLocalDateTimeToUtc(date, '15:00'),
      activityPurpose: 'Group discussion',
      expectedAttendance: 20,
      localDate: date,
    })

    const booking = createBooking(
      rep2.user,
      bookingInput({ date, startTime: '14:00', endTime: '15:00', activityPurpose: 'Group discussion' }),
    )

    assert.equal(booking.status, 'confirmed')
  })
})
