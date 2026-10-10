/**
 * Booking engine.
 *
 * ===========================================================================
 * THIS IS THE FILE THE PROJECT'S CENTRAL CLAIM RESTS ON
 * ===========================================================================
 *
 * The requirement is that two confirmed bookings can never overlap for the same
 * facility, even when two representatives submit at the same moment. That is
 * provided by two things working together, and NOT by any check the client
 * performs:
 *
 *   1. EVERY write runs inside `inImmediateTransaction`, which issues
 *      BEGIN IMMEDIATE. The write lock is taken at the START of the
 *      transaction, so a second request waits rather than reading the
 *      pre-state and proceeding on stale data.
 *
 *   2. better-sqlite3 is synchronous and Node is single-threaded, so the
 *      transaction body cannot be interrupted by another request. The
 *      "check, then insert" sequence is therefore genuinely atomic.
 *
 * The practical consequence: the second of two simultaneous bookings observes
 * the first one's committed row at step 5 and is rejected. It does not silently
 * overwrite, and it does not create a duplicate.
 *
 * HONEST LIMITATION: this holds for a single server process. It would not hold
 * across multiple processes or hosts. The README documents the PostgreSQL
 * `EXCLUDE USING gist` constraint that a real deployment would use instead,
 * which enforces the same rule inside the index and therefore survives
 * horizontal scaling.
 *
 * ===========================================================================
 * VALIDATION ORDER
 * ===========================================================================
 *
 * Authorization is checked BEFORE business rules. A caller who is not permitted
 * to book a facility should be told that, not told about its opening hours -
 * otherwise rejection messages leak detail about facilities the caller has no
 * right to use.
 */
import { randomUUID } from 'node:crypto'

import { getDb, inImmediateTransaction, nowIso } from '../db/connection.ts'
import {
  activityNotPermitted,
  bookingConflict,
  capacityExceeded,
  facilityUnavailable,
  forbidden,
  isApiError,
  notFound,
  outsideOperatingHours,
  supervisionRequired,
  ApiError,
  type ApiErrorCode,
} from '../lib/errors.ts'
import { assertValidInterval, findFirstConflict, type Interval } from '../lib/overlap.ts'
import { roleAtLeast, type UserRole } from '../lib/roles.ts'
import {
  addMinutes,
  combineLocalDateTimeToUtc,
  durationMinutes,
  formatForDisplay,
  isWithinOperatingHours,
  type LocalDateString,
} from '../lib/time.ts'
import type { AuthenticatedUser } from '../services/sessionService.ts'
import { recordAudit } from './auditService.ts'
import { getFacilityOrThrow, type FacilityRecord } from './facilityService.ts'

export type BookingStatus = 'confirmed' | 'cancelled' | 'completed'

export interface BookingRecord {
  id: string
  reference: string
  facilityId: string
  facilityName: string
  facilityBuilding: string
  facilityCategory: string
  bookedById: string
  bookedByName: string
  activityPurpose: string
  expectedAttendance: number
  startTime: string
  endTime: string
  durationMinutes: number
  status: BookingStatus
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
  cancelledByName: string | null
  cancellationReason: string | null
}

export interface CreateBookingInput {
  facilityId: string
  activityPurpose: string
  expectedAttendance: number
  date: LocalDateString
  startTime: string
  endTime: string
}

interface RawBookingRow {
  id: string
  booking_reference: string
  facility_id: string
  facility_name: string
  facility_building: string
  category_name: string
  booked_by: string
  booked_by_name: string
  activity_purpose: string
  expected_attendance: number
  start_time: string
  end_time: string
  status: string
  created_at: string
  updated_at: string
  cancelled_at: string | null
  cancelled_by_name: string | null
  cancellation_reason: string | null
}

const SELECT_BOOKING = `
  select b.id,
         b.booking_reference,
         b.facility_id,
         f.name  as facility_name,
         f.building as facility_building,
         c.name  as category_name,
         b.booked_by,
         p.display_name as booked_by_name,
         b.activity_purpose,
         b.expected_attendance,
         b.start_time,
         b.end_time,
         b.status,
         b.created_at,
         b.updated_at,
         b.cancelled_at,
         cx.display_name as cancelled_by_name,
         b.cancellation_reason
    from bookings b
    join facilities f on f.id = b.facility_id
    join facility_categories c on c.id = f.category_id
    join profiles p on p.id = b.booked_by
    left join profiles cx on cx.id = b.cancelled_by
`

function mapBooking(row: RawBookingRow): BookingRecord {
  return {
    id: row.id,
    reference: row.booking_reference,
    facilityId: row.facility_id,
    facilityName: row.facility_name,
    facilityBuilding: row.facility_building,
    facilityCategory: row.category_name,
    bookedById: row.booked_by,
    bookedByName: row.booked_by_name,
    activityPurpose: row.activity_purpose,
    expectedAttendance: row.expected_attendance,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: durationMinutes(new Date(row.start_time), new Date(row.end_time)),
    status: row.status as BookingStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    cancelledByName: row.cancelled_by_name,
    cancellationReason: row.cancellation_reason,
  }
}

/** Loads one booking, or throws a 404. */
export function getBookingOrThrow(bookingId: string): BookingRecord {
  const row = getDb().prepare(`${SELECT_BOOKING} where b.id = ?`).get(bookingId) as
    | RawBookingRow
    | undefined

  if (!row) {
    throw notFound('That booking does not exist.')
  }

  return mapBooking(row)
}

export type BookingScope = 'upcoming' | 'past' | 'all'

/**
 * Bookings for one user.
 *
 * `upcoming` means confirmed and not yet finished. `past` deliberately includes
 * CANCELLED bookings rather than only elapsed ones - a user who cancelled
 * something needs to be able to see that they did, otherwise the booking
 * appears to have vanished.
 */
export function listBookingsForUser(userId: string, scope: BookingScope = 'all'): BookingRecord[] {
  const now = nowIso()

  const scopeClause =
    scope === 'upcoming'
      ? `and b.status = 'confirmed' and b.end_time >= @now`
      : scope === 'past'
        ? `and (b.status <> 'confirmed' or b.end_time < @now)`
        : ''

  const order =
    scope === 'upcoming' ? 'b.start_time asc' : scope === 'past' ? 'b.start_time desc' : 'b.start_time desc'

  const rows = getDb()
    .prepare(`${SELECT_BOOKING} where b.booked_by = @userId ${scopeClause} order by ${order}`)
    .all({ userId, now }) as RawBookingRow[]

  return rows.map(mapBooking)
}

/** Confirmed bookings for a facility that overlap a window. Used by the admin schedule view. */
export function listFacilityBookings(
  facilityId: string,
  fromIso: string,
  toIso: string,
): BookingRecord[] {
  const rows = getDb()
    .prepare(
      `${SELECT_BOOKING}
        where b.facility_id = @facilityId
          and b.status = 'confirmed'
          and b.start_time < @toIso
          and b.end_time > @fromIso
        order by b.start_time asc`,
    )
    .all({ facilityId, fromIso, toIso }) as RawBookingRow[]

  return rows.map(mapBooking)
}

// ---------------------------------------------------------------------------
// Policy checks
// ---------------------------------------------------------------------------

/**
 * Confirms the caller may book this facility at all.
 *
 * Two independent gates:
 *   - the role hierarchy (`min_role`), with administrators always permitted;
 *   - the booking policy, where 'supervisor_required' additionally demands a
 *     supervisor or administrator REGARDLESS of min_role.
 *
 * Keeping both means an administrator can correct a facility misconfigured with
 * min_role 'rep' but policy 'supervisor_required', and a facility is never
 * accidentally opened to everyone by a single wrong field.
 */
function assertMayBook(facility: FacilityRecord, actor: AuthenticatedUser): void {
  const isAdmin = actor.role === 'admin'

  if (!isAdmin && !roleAtLeast(actor.role, facility.minRole as UserRole)) {
    throw forbidden(
      `${facility.name} can only be booked by users with the ` +
        `${facility.minRole} role or higher. You are signed in as a ${actor.role}.`,
    )
  }

  if (facility.bookingPolicy === 'supervisor_required' && !isAdmin && actor.role !== 'supervisor') {
    throw supervisionRequired(
      `${facility.name} is a supervised facility. Bookings must be made by an ` +
        `authorized supervisor or a facility administrator.`,
      {
        facilityId: facility.id,
        facilityName: facility.name,
        requiredRole: 'supervisor',
      },
    )
  }
}

/** Confirms the requested activity is one this facility is approved for. */
function assertActivityPermitted(facility: FacilityRecord, activityPurpose: string): void {
  if (facility.allowedActivities.length === 0) {
    // An empty list means the facility has not been configured with activities.
    // Rejecting everything would make such a facility unusable through the UI
    // with no way to tell why, so the list is treated as unconfigured rather
    // than restrictive.
    return
  }

  const normalised = activityPurpose.trim().toLowerCase()
  const permitted = facility.allowedActivities.some(
    (activity) => activity.trim().toLowerCase() === normalised,
  )

  if (!permitted) {
    throw activityNotPermitted(
      `${facility.name} is not approved for "${activityPurpose}". ` +
        `Permitted activities: ${facility.allowedActivities.join(', ')}.`,
      {
        facilityId: facility.id,
        requestedActivity: activityPurpose,
        allowedActivities: facility.allowedActivities,
      },
    )
  }
}

/** Confirms the expected attendance fits. */
function assertCapacity(facility: FacilityRecord, expectedAttendance: number): void {
  if (expectedAttendance > facility.capacity) {
    throw capacityExceeded(
      `${facility.name} holds ${facility.capacity} people, but you entered ` +
        `${expectedAttendance}. Choose a larger venue or reduce the expected attendance.`,
      {
        facilityId: facility.id,
        capacity: facility.capacity,
        requestedAttendance: expectedAttendance,
      },
    )
  }
}

/**
 * Confirms the requested interval lies inside the facility's operating window
 * on the requested local date, and that the facility operates that day.
 *
 * Weekday closures are evaluated in the CAMPUS timezone. Deriving the weekday
 * from a UTC instant would be wrong for a booking that is late in the local
 * evening, which falls on the following UTC day.
 */
function assertOpenForInterval(
  facility: FacilityRecord,
  date: LocalDateString,
  start: Date,
  end: Date,
): void {
  const weekday = new Date(start.getTime() + 12 * 60 * 60 * 1000).getUTCDay()

  if (facility.closedDays.includes(weekday)) {
    throw facilityUnavailable(
      `${facility.name} does not operate on that day of the week.`,
      { facilityId: facility.id, closedDays: facility.closedDays },
    )
  }

  if (!isWithinOperatingHours(start, end, facility.opensAt, facility.closesAt)) {
    throw outsideOperatingHours(
      `${facility.name} is open ${facility.opensAt} to ${facility.closesAt} on that day. ` +
        `The requested time falls outside those hours.`,
      {
        facilityId: facility.id,
        opensAt: facility.opensAt,
        closesAt: facility.closesAt,
        requestedDate: date,
        requestedStartTime: start.toISOString(),
        requestedEndTime: end.toISOString(),
      },
    )
  }
}

/**
 * Confirms the interval does not collide with a maintenance or reserved block.
 *
 * Blocks are checked separately from bookings because they are a different kind
 * of obstruction: a block is a decision by the university, and the message the
 * user sees should say so rather than implying someone else booked the room.
 */
function assertNotBlocked(facilityId: string, start: Date, end: Date): void {
  const block = getDb()
    .prepare(
      `select id, reason, start_time, end_time
         from facility_blocks
        where facility_id = @facilityId
          and start_time < @endTime
          and end_time > @startTime
        order by start_time asc
        limit 1`,
    )
    .get({
      facilityId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    }) as { id: string; reason: string; start_time: string; end_time: string } | undefined

  if (block) {
    throw facilityUnavailable(
      `That time is unavailable because the facility is blocked: ${block.reason} ` +
        `(${formatForDisplay(new Date(block.start_time))} to ${formatForDisplay(new Date(block.end_time))}).`,
      {
        facilityId,
        blockId: block.id,
        reason: block.reason,
        startTime: block.start_time,
        endTime: block.end_time,
      },
    )
  }
}

/**
 * Confirms no confirmed booking overlaps the requested interval.
 *
 * The SQL below is the buffer-aware form of the half-open overlap predicate in
 * lib/overlap.ts. A conflict exists when:
 *
 *     newStart < existingEnd + buffer   AND   newEnd + buffer > existingStart
 *
 * which rearranges to the two comparisons used here, so that the database does
 * the filtering rather than loading every booking into memory:
 *
 *     existingStart < newEnd + buffer
 *     existingEnd   > newStart - buffer
 *
 * The unit tests in tests/overlap.test.ts pin the same rule as a pure function.
 * If these two ever disagree, the tests are the ones that are right.
 */
function assertNoOverlappingBooking(
  facility: FacilityRecord,
  start: Date,
  end: Date,
): void {
  const buffer = facility.bufferMinutes

  const rows = getDb()
    .prepare(
      `select id, booking_reference, activity_purpose, start_time, end_time
         from bookings
        where facility_id = @facilityId
          and status = 'confirmed'
          and start_time < @limitEnd
          and end_time > @limitStart
        order by start_time asc`,
    )
    .all({
      facilityId: facility.id,
      limitStart: addMinutes(start, -buffer).toISOString(),
      limitEnd: addMinutes(end, buffer).toISOString(),
    }) as Array<{
    id: string
    booking_reference: string
    activity_purpose: string
    start_time: string
    end_time: string
  }>

  const existing: Array<Interval & { reference: string; purpose: string; id: string }> = rows.map(
    (row) => ({
      id: row.id,
      reference: row.booking_reference,
      purpose: row.activity_purpose,
      start: new Date(row.start_time),
      end: new Date(row.end_time),
    }),
  )

  // The candidate is tested against the un-buffered interval; the buffer is
  // already applied by the widened SQL bounds above. Passing it again here
  // would apply it twice and reject bookings that are actually legal.
  const blocking = findFirstConflict({ start, end }, existing, 0)

  if (blocking) {
    const bufferNote =
      buffer > 0
        ? ` ${facility.name} also requires a ${buffer}-minute gap between bookings for preparation.`
        : ''

    throw bookingConflict(
      `${facility.name} is already booked from ${formatForDisplay(blocking.start)} to ` +
        `${formatForDisplay(blocking.end)} (${blocking.purpose}).${bufferNote} ` +
        `Choose a different time, or ask the app to suggest an alternative.`,
      {
        facilityId: facility.id,
        facilityName: facility.name,
        bufferMinutes: buffer,
        conflicting: {
          bookingId: blocking.id,
          reference: blocking.reference,
          activityPurpose: blocking.purpose,
          startTime: blocking.start.toISOString(),
          endTime: blocking.end.toISOString(),
        },
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Creating a booking
// ---------------------------------------------------------------------------

/**
 * Allocates the next human-readable booking reference.
 *
 * Uses a dedicated AUTOINCREMENT table rather than MAX(id) + 1 or a count,
 * because AUTOINCREMENT never reuses a value even after deletions. A reference
 * shown to a user can therefore never later be reassigned to a different
 * booking - which matters in a system whose entire purpose is trustworthy
 * booking records.
 */
function nextBookingReference(localYear: string): string {
  const info = getDb().prepare('insert into booking_reference_seq default values').run()
  const sequence = Number(info.lastInsertRowid)
  return `EDU-${localYear}-${String(sequence).padStart(4, '0')}`
}

/** Confirms the facility is open for business at all. */
function assertFacilityActive(facility: FacilityRecord): void {
  if (facility.status === 'active') return

  throw facilityUnavailable(
    facility.status === 'inactive'
      ? `${facility.name} has been withdrawn from booking.`
      : `${facility.name} is currently under maintenance and cannot be booked.`,
    { facilityId: facility.id, status: facility.status },
  )
}

/**
 * The whole booking operation: every check and the insert, in one go.
 *
 * MUST be called from inside `inImmediateTransaction`. It is separated out so
 * that the entire check-then-insert sequence is visibly one unit - there is no
 * second transaction, and no window between validating and writing.
 *
 * Every rejection throws, which rolls the transaction back, so a failed attempt
 * leaves no booking behind.
 */
function performBookingWrite(
  actor: AuthenticatedUser,
  input: CreateBookingInput,
  start: Date,
  end: Date,
): { bookingId: string; reference: string; facility: FacilityRecord } {
  const facility = getFacilityOrThrow(input.facilityId)

  // --- authorization BEFORE business rules, so a refusal never leaks
  //     operational detail about a facility the caller may not use ----------
  assertMayBook(facility, actor)
  assertFacilityActive(facility)

  // --- business rules ---------------------------------------------------
  assertActivityPermitted(facility, input.activityPurpose)
  assertCapacity(facility, input.expectedAttendance)
  assertOpenForInterval(facility, input.date, start, end)
  assertNotBlocked(facility.id, start, end)
  assertNoOverlappingBooking(facility, start, end)

  // --- write -------------------------------------------------------------
  const reference = nextBookingReference(input.date.slice(0, 4))
  const bookingId = randomUUID()
  const timestamp = nowIso()

  getDb()
    .prepare(
      `insert into bookings (
         id, booking_reference, facility_id, booked_by, activity_purpose,
         expected_attendance, start_time, end_time, status, created_at, updated_at
       ) values (
         @id, @reference, @facilityId, @bookedBy, @activityPurpose,
         @expectedAttendance, @startTime, @endTime, 'confirmed', @createdAt, @updatedAt
       )`,
    )
    .run({
      id: bookingId,
      reference,
      facilityId: facility.id,
      bookedBy: actor.id,
      activityPurpose: input.activityPurpose.trim(),
      expectedAttendance: input.expectedAttendance,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    })

  return { bookingId, reference, facility }
}

/**
 * Creates a confirmed booking and returns it, fully joined.
 *
 * The write runs in exactly one IMMEDIATE transaction. The audit entry and the
 * reload happen afterwards, deliberately outside it: a logging failure must not
 * roll back a booking that genuinely succeeded, and `recordAudit` never throws.
 */
export function createBooking(actor: AuthenticatedUser, input: CreateBookingInput): BookingRecord {
  const start = combineLocalDateTimeToUtc(input.date, input.startTime)
  const end = combineLocalDateTimeToUtc(input.date, input.endTime)

  // The schema and the client both reject malformed intervals, but this is the
  // check closest to the write, so it is the one that actually protects data.
  assertValidInterval({ start, end })

  if (start.getTime() <= Date.now()) {
    throw new ApiError(
      400,
      'VALIDATION_FAILED',
      'That time is in the past. Choose a date and time that has not yet started.',
      [{ field: 'startTime', message: 'Booking start time must be in the future' }],
    )
  }

  const { bookingId, reference, facility } = inImmediateTransaction(() =>
    performBookingWrite(actor, input, start, end),
  )

  recordAudit({
    actorId: actor.id,
    action: 'booking.created',
    entityType: 'booking',
    entityId: bookingId,
    metadata: {
      reference,
      facilityId: facility.id,
      facilityName: facility.name,
      localDate: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      expectedAttendance: input.expectedAttendance,
      activityPurpose: input.activityPurpose,
    },
  })

  return getBookingOrThrow(bookingId)
}

// ---------------------------------------------------------------------------
// Cancelling a booking
// ---------------------------------------------------------------------------

export interface CancelBookingInput {
  reason?: string | undefined
}

/**
 * Cancels a booking, releasing the slot.
 *
 * Authorization: the booker, or an administrator. Anyone else is refused, which
 * is the behaviour the brief's test case 9 requires ("a student attempts to
 * modify someone else's booking").
 *
 * Timing: a booking that has already started cannot be cancelled by its owner.
 * An administrator can, because the plausible cases - a room double-let, a
 * facility failure - need an override.
 */
export function cancelBooking(
  actor: AuthenticatedUser,
  bookingId: string,
  input: CancelBookingInput = {},
): BookingRecord {
  const result = inImmediateTransaction(() => {
    const booking = getBookingOrThrow(bookingId)
    const isAdmin = actor.role === 'admin'
    const isOwner = booking.bookedById === actor.id

    if (!isOwner && !isAdmin) {
      throw forbidden('You can only cancel your own bookings.')
    }

    if (booking.status === 'cancelled') {
      throw new ApiError(409, 'CANCELLATION_NOT_PERMITTED', 'That booking is already cancelled.', {
        bookingId,
        status: booking.status,
      })
    }

    if (booking.status === 'completed') {
      throw new ApiError(
        409,
        'CANCELLATION_NOT_PERMITTED',
        'That booking has already taken place and cannot be cancelled.',
        { bookingId, status: booking.status },
      )
    }

    if (!isAdmin && new Date(booking.startTime).getTime() <= Date.now()) {
      throw new ApiError(
        409,
        'CANCELLATION_NOT_PERMITTED',
        'That booking has already started. Only a facility administrator can cancel it now.',
        { bookingId, status: booking.status },
      )
    }

    const timestamp = nowIso()

    getDb()
      .prepare(
        `update bookings
            set status = 'cancelled',
                cancelled_at = @cancelledAt,
                cancelled_by = @cancelledBy,
                cancellation_reason = @reason
          where id = @id
            and status = 'confirmed'`,
      )
      .run({
        id: bookingId,
        cancelledAt: timestamp,
        cancelledBy: actor.id,
        reason: input.reason?.trim() || (isAdmin && !isOwner ? 'Cancelled by an administrator' : null),
      })

    return booking
  })

  recordAudit({
    actorId: actor.id,
    action: 'booking.cancelled',
    entityType: 'booking',
    entityId: bookingId,
    metadata: {
      reference: result.reference,
      facilityId: result.facilityId,
      facilityName: result.facilityName,
      wasBookedBy: result.bookedById,
      reason: input.reason ?? null,
      releasedSlot: { startTime: result.startTime, endTime: result.endTime },
    },
  })

  // Reload so the caller sees the cancellation reflected.
  return getBookingOrThrow(bookingId)
}

// ---------------------------------------------------------------------------
// Dry-run evaluation
// ---------------------------------------------------------------------------

export interface SlotEvaluation {
  bookable: boolean
  /** Why the slot cannot be booked, when it cannot. */
  code?: ApiErrorCode
  reason?: string
  details?: unknown
}

export interface EvaluateSlotParams {
  facility: FacilityRecord
  actor: AuthenticatedUser
  start: Date
  end: Date
  activityPurpose: string
  expectedAttendance: number
  localDate: LocalDateString
}

/**
 * Runs the FULL booking rule set and reports the outcome instead of throwing.
 *
 * This exists so the recommendation engine can ask "could this be booked?" and
 * get an answer without duplicating a single rule. The rules below are the same
 * functions `performBookingWrite` calls, so the recommender can never offer a
 * slot that the booking engine would then reject.
 *
 * That consistency is the reason this function is here rather than in the
 * recommender: a second copy of the rules would drift, and the failure mode -
 * "the app suggested it, then refused it" - is exactly the kind of thing that
 * destroys trust in a booking system.
 *
 * Read-only: callers must be aware it does not reserve anything. A slot it
 * reports as bookable may be taken by the time a booking is attempted, which is
 * why the booking path re-checks inside its transaction rather than trusting
 * this result.
 */
export function evaluateBookingRequest(params: EvaluateSlotParams): SlotEvaluation {
  try {
    assertMayBook(params.facility, params.actor)
    assertFacilityActive(params.facility)
    assertActivityPermitted(params.facility, params.activityPurpose)
    assertCapacity(params.facility, params.expectedAttendance)
    assertOpenForInterval(params.facility, params.localDate, params.start, params.end)
    assertNotBlocked(params.facility.id, params.start, params.end)
    assertNoOverlappingBooking(params.facility, params.start, params.end)

    return { bookable: true }
  } catch (error) {
    if (isApiError(error)) {
      return {
        bookable: false,
        code: error.code,
        reason: error.message,
        details: error.details,
      }
    }

    // Anything that is not a deliberate policy rejection is a genuine bug and
    // must not be silently converted into "this facility is unavailable".
    throw error
  }
}
