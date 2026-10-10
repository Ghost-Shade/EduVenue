/**
 * The no-overlap guarantee, tested against the DATABASE ITSELF.
 *
 * ===========================================================================
 * WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE SUITE
 * ===========================================================================
 *
 * Every other booking test goes through `bookingService.ts`, which checks for a
 * conflict and produces a friendly message. Those tests prove that a user gets a
 * good error. They do NOT prove the guarantee, because they exercise the code
 * that is supposed to prevent the overlap - and code that is supposed to do
 * something is exactly the code that can be wrong.
 *
 * This file bypasses the service completely. It writes rows straight into
 * `bookings` with plain SQL, as a second application instance, a migration
 * script, or a careless `psql` session would, and asserts that POSTGRESQL
 * refuses. That is the claim the project actually makes: two confirmed bookings
 * cannot overlap, no matter which process asks.
 *
 * ===========================================================================
 * WHY EVERY ASSERTION CHECKS THE SQLSTATE
 * ===========================================================================
 *
 * An insert can fail for many reasons - a foreign key, a CHECK, a missing
 * column. A test that only asserted "it threw" would pass while the constraint
 * this file exists to verify did nothing at all, and the whole file would be
 * vacuous. So each refusal is checked to be SQLSTATE 23P01, the exclusion
 * violation specifically, and nothing else counts.
 *
 * ===========================================================================
 * WHAT THE HALF-BUFFER TESTS ARE ACTUALLY PINNING
 * ===========================================================================
 *
 * A facility with `buffer_minutes = b` requires a gap of exactly b between
 * consecutive bookings. The constraint achieves that by widening each stored
 * booking by b/2 at each end. Two properties follow, and both are load-bearing:
 *
 *   - a gap of exactly b is ACCEPTED, because the widened windows touch and
 *     half-open ranges that touch do not overlap;
 *   - a gap of less than b is REJECTED.
 *
 * The half is what makes this equal to the rule the service applies. Widening
 * each side by the FULL buffer - the obvious mistake - would demand a gap of 2b,
 * silently refusing bookings that are legal. The "accepts exactly the buffer as
 * a gap" test below is the one that fails if that mistake is ever made, and it
 * is why the buffer and half-buffer forms are described as equivalent rather
 * than similar.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import './env.ts'
import { SQLSTATE, execute, query, sqlState } from '../db/connection.ts'
import { bufferWindow } from '../lib/overlap.ts'
import { addDaysToLocalDate, combineLocalDateTimeToUtc, toLocalDateString } from '../lib/time.ts'
import { localDateBounds, prepareTestDatabase } from './harness.ts'

await prepareTestDatabase()

/** A real facility and a real profile, so the foreign keys are satisfied. */
const FACILITY_A = 'fac-lecture-hall-a'
const FACILITY_B = 'fac-computing-lab-a'
const BOOKED_BY = 'user-rep-brian'

/**
 * Dates 60+ days out. The seed only covers -10 to +4, so these are free, and
 * one date per test keeps the cases from interfering with each other.
 */
const TODAY = toLocalDateString(new Date())
const dayOffset = (days: number): string => addDaysToLocalDate(TODAY, days)

let sequence = 0

interface InsertOptions {
  facilityId?: string
  bufferMinutes?: number
  /** Local date, "YYYY-MM-DD". */
  date: string
  /** Local wall-clock start, "HH:MM". */
  startTime: string
  endTime: string
  status?: 'confirmed' | 'cancelled' | 'completed'
  /** Overrides the derived effective window, to test the CHECK constraint. */
  effectiveOverride?: { start: Date; end: Date }
}

/**
 * Writes a booking row DIRECTLY, with no service-layer validation.
 *
 * This is the point of the file: whatever the constraint refuses here, it
 * refuses for any writer.
 */
async function insertBooking(options: InsertOptions): Promise<string> {
  sequence += 1

  const id = `test-raw-${String(sequence).padStart(3, '0')}`
  const bufferMinutes = options.bufferMinutes ?? 0
  const status = options.status ?? 'confirmed'

  const start = combineLocalDateTimeToUtc(options.date, options.startTime)
  const end = combineLocalDateTimeToUtc(options.date, options.endTime)

  const window = bufferWindow({ start, end }, bufferMinutes)

  await execute(
    `insert into bookings (
       id, booking_reference, facility_id, booked_by, activity_purpose,
       expected_attendance, start_time, end_time, buffer_minutes,
       effective_start, effective_end, status, cancelled_at
     ) values (
       @id, @reference, @facilityId, @bookedBy, @purpose,
       @attendance, @startTime, @endTime, @bufferMinutes,
       @effectiveStart, @effectiveEnd, @status, @cancelledAt
     )`,
    {
      id,
      reference: `EDU-TEST-${String(sequence).padStart(4, '0')}`,
      facilityId: options.facilityId ?? FACILITY_A,
      bookedBy: BOOKED_BY,
      purpose: 'Raw insert for the constraint test',
      attendance: 10,
      startTime: start,
      endTime: end,
      bufferMinutes,
      effectiveStart: options.effectiveOverride?.start ?? window.start,
      effectiveEnd: options.effectiveOverride?.end ?? window.end,
      status,
      // The schema requires a cancellation timestamp on exactly the rows that
      // are cancelled, so a raw cancelled row has to carry one. Otherwise this
      // helper would trip a CHECK constraint and the tests below would be
      // measuring the wrong rule.
      cancelledAt: status === 'cancelled' ? new Date() : null,
    },
  )

  return id
}

/**
 * Runs an insert that must be refused, and returns its SQLSTATE.
 *
 * Returning the code rather than a boolean is what lets each caller assert it
 * was refused FOR THE RIGHT REASON.
 */
async function sqlStateOfRefusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error) {
    const code = sqlState(error)
    if (code === undefined) throw error
    return code
  }

  throw new Error('Expected the database to refuse the insert, but it succeeded.')
}

// ---------------------------------------------------------------------------
// The constraint exists
// ---------------------------------------------------------------------------

describe('the exclusion constraint', () => {
  test('is installed, so a schema regression fails here rather than silently', async () => {
    const rows = await query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = current_schema() and indexname = 'bookings_no_overlap'`,
    )

    assert.equal(rows.length, 1, 'bookings_no_overlap is not installed - the guarantee is absent')

    // And it is a real exclusion constraint, not merely something with the
    // right name.
    const constraint = await query<{ contype: string }>(
      `select contype from pg_constraint
        where conname = 'bookings_no_overlap' and conrelid = 'bookings'::regclass`,
    )

    assert.equal(constraint.length, 1)
    assert.equal(constraint[0]?.contype, 'x', 'the constraint should be an exclusion constraint')
  })
})

// ---------------------------------------------------------------------------
// Overlap, refused
// ---------------------------------------------------------------------------

describe('overlapping confirmed bookings', () => {
  test('refuses an exact overlap', async () => {
    const date = dayOffset(60)

    await insertBooking({ date, startTime: '09:00', endTime: '10:00' })

    const code = await sqlStateOfRefusal(() =>
      insertBooking({ date, startTime: '09:00', endTime: '10:00' }),
    )

    assert.equal(code, SQLSTATE.exclusionViolation)
  })

  test('refuses a booking contained inside an existing one', async () => {
    const date = dayOffset(61)

    await insertBooking({ date, startTime: '09:00', endTime: '13:00' })

    const code = await sqlStateOfRefusal(() =>
      insertBooking({ date, startTime: '10:00', endTime: '11:00' }),
    )

    assert.equal(code, SQLSTATE.exclusionViolation)
  })

  test('refuses a booking that contains an existing one', async () => {
    const date = dayOffset(62)

    await insertBooking({ date, startTime: '10:00', endTime: '11:00' })

    const code = await sqlStateOfRefusal(() =>
      insertBooking({ date, startTime: '08:00', endTime: '13:00' }),
    )

    assert.equal(code, SQLSTATE.exclusionViolation)
  })

  test('refuses a one-minute overlap, which is the case a coarse check would miss', async () => {
    const date = dayOffset(63)

    await insertBooking({ date, startTime: '09:00', endTime: '10:00' })

    const code = await sqlStateOfRefusal(() =>
      insertBooking({ date, startTime: '09:59', endTime: '11:00' }),
    )

    assert.equal(code, SQLSTATE.exclusionViolation)
  })
})

// ---------------------------------------------------------------------------
// Non-overlap, allowed
// ---------------------------------------------------------------------------

describe('bookings that do not overlap', () => {
  test('allows back-to-back bookings touching at the boundary', async () => {
    const date = dayOffset(64)

    await insertBooking({ date, startTime: '09:00', endTime: '10:00' })

    // Half-open [09:00, 10:00) and [10:00, 11:00) share no instant. Rejecting
    // this would break the ordinary case of consecutive classes.
    const second = await insertBooking({ date, startTime: '10:00', endTime: '11:00' })

    const bounds = localDateBounds(date)
    const rows = await query<{ id: string }>(
      `select id from bookings
        where facility_id = @facilityId and start_time >= @from and start_time < @to
        order by start_time`,
      { facilityId: FACILITY_A, from: bounds.from, to: bounds.to },
    )

    assert.equal(rows.length, 2, 'both back-to-back bookings should be present')
    assert.ok(rows.some((row) => row.id === second))
  })

  test('allows the same instants at a different facility', async () => {
    const date = dayOffset(65)

    await insertBooking({ facilityId: FACILITY_A, date, startTime: '09:00', endTime: '10:00' })

    // The constraint is scoped per facility. A single global one would make the
    // whole campus able to host one session at a time. A direct insert that
    // throws fails the test, which is all "this must be accepted" needs to say.
    await insertBooking({
      facilityId: FACILITY_B,
      date,
      startTime: '09:00',
      endTime: '10:00',
      bufferMinutes: 15,
    })
  })

  test('allows the same local times on a different day', async () => {
    const date = dayOffset(66)
    const nextDay = dayOffset(67)

    await insertBooking({ facilityId: FACILITY_A, date, startTime: '08:00', endTime: '09:00' })
    await insertBooking({
      facilityId: FACILITY_A,
      date: nextDay,
      startTime: '08:00',
      endTime: '09:00',
    })
  })
})

// ---------------------------------------------------------------------------
// The partial predicate: only CONFIRMED rows block
// ---------------------------------------------------------------------------

describe('the predicate covers only confirmed bookings', () => {
  test('a cancelled booking stops blocking its slot', async () => {
    const date = dayOffset(68)

    const first = await insertBooking({ date, startTime: '09:00', endTime: '10:00' })

    // While confirmed, it blocks.
    assert.equal(
      await sqlStateOfRefusal(() => insertBooking({ date, startTime: '09:00', endTime: '10:00' })),
      SQLSTATE.exclusionViolation,
    )

    await execute(`update bookings set status = 'cancelled', cancelled_at = now() where id = @id`, {
      id: first,
    })

    // Now it does not. This is what makes cancelling release the slot WITHOUT
    // any code that explicitly frees it - the row simply leaves the index.
    const second = await insertBooking({ date, startTime: '09:00', endTime: '10:00' })

    assert.ok(second)
  })

  test('a completed booking does not block, and a cancelled one may overlap freely', async () => {
    const date = dayOffset(69)

    await insertBooking({ date, startTime: '09:00', endTime: '10:00', status: 'cancelled' })
    await insertBooking({ date, startTime: '09:00', endTime: '10:00', status: 'completed' })

    const bounds = localDateBounds(date)
    const rows = await query<{ id: string }>(
      `select id from bookings
        where facility_id = @facilityId and start_time >= @from and start_time < @to`,
      { facilityId: FACILITY_A, from: bounds.from, to: bounds.to },
    )

    assert.equal(rows.length, 2, 'neither row should have been refused for overlapping')
  })
})

// ---------------------------------------------------------------------------
// The buffer, applied as half-widths
// ---------------------------------------------------------------------------

describe('the preparation buffer', () => {
  const BUFFER = 60

  test('refuses a gap shorter than the buffer', async () => {
    const date = dayOffset(70)

    await insertBooking({ date, startTime: '09:00', endTime: '10:00', bufferMinutes: BUFFER })

    // A 30-minute gap is half the required 60, so the widened windows overlap.
    const code = await sqlStateOfRefusal(() =>
      insertBooking({ date, startTime: '10:30', endTime: '11:30', bufferMinutes: BUFFER }),
    )

    assert.equal(code, SQLSTATE.exclusionViolation)
  })

  test('accepts exactly the buffer as a gap', async () => {
    const date = dayOffset(71)

    await insertBooking({ date, startTime: '09:00', endTime: '10:00', bufferMinutes: BUFFER })

    // A 60-minute gap is exactly what was asked for. The first booking's window
    // ends at 10:30 and the second's begins at 10:30: they touch, and touching
    // half-open ranges do not overlap.
    //
    // THIS IS THE ASSERTION THAT CATCHES THE DOUBLE-BUFFER BUG. If each side
    // were widened by the full buffer instead of half, the first window would
    // end at 11:00 and the second would begin at 10:00, this insert would be
    // refused, and every legal 60-minute gap would be rejected in production.
    const second = await insertBooking({
      date,
      startTime: '11:00',
      endTime: '12:00',
      bufferMinutes: BUFFER,
    })

    assert.ok(second, 'a gap of exactly the buffer should be accepted')
  })

  test('applies no gap at all when the buffer is zero', async () => {
    const date = dayOffset(72)

    await insertBooking({ date, startTime: '09:00', endTime: '10:00', bufferMinutes: 0 })

    const second = await insertBooking({ date, startTime: '10:00', endTime: '11:00', bufferMinutes: 0 })
    assert.ok(second, 'with no buffer, touching bookings are legal')
  })

  test('treats facilities with different buffers independently', async () => {
    const date = dayOffset(73)

    // Same instants, same buffer, different facilities: the buffer applies
    // within a facility, not across the campus.
    await insertBooking({
      facilityId: FACILITY_A,
      date,
      startTime: '09:00',
      endTime: '10:00',
      bufferMinutes: BUFFER,
    })

    await insertBooking({
      facilityId: FACILITY_B,
      date,
      startTime: '09:30',
      endTime: '10:30',
      bufferMinutes: BUFFER,
    })
  })
})

// ---------------------------------------------------------------------------
// The derived window cannot drift
// ---------------------------------------------------------------------------

describe('the derived window', () => {
  test('cannot disagree with the buffer it was derived from', async () => {
    const date = dayOffset(74)

    // If these columns could be set to anything, a writer could widen a
    // booking's window past its buffer - or narrow it to nothing - and the
    // constraint would then be enforcing a rule nobody chose.
    const code = await sqlStateOfRefusal(() =>
      insertBooking({
        date,
        startTime: '09:00',
        endTime: '10:00',
        bufferMinutes: 60,
        effectiveOverride: {
          start: combineLocalDateTimeToUtc(date, '08:00'),
          end: combineLocalDateTimeToUtc(date, '11:00'),
        },
      }),
    )

    assert.equal(
      code,
      SQLSTATE.checkViolation,
      'a mismatched effective window should fail the CHECK, not the exclusion constraint',
    )
  })
})
