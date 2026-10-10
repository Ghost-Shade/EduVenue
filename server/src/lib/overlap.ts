/**
 * Interval overlap logic - the pure heart of conflict prevention.
 *
 * ===========================================================================
 * HALF-OPEN INTERVALS
 * ===========================================================================
 *
 * Every interval in EduVenue is half-open: [start, end).
 *
 * The start instant belongs to the interval; the end instant does not. This is
 * what allows a booking ending at 16:00 and another beginning at 16:00 to
 * coexist, which is the normal and expected behaviour for back-to-back
 * classes - and is exactly what the brief calls for.
 *
 * Under that model, two intervals overlap when:
 *
 *     a.start < b.end   AND   a.end > b.start
 *
 * Both comparisons are STRICT. Using <= on either side would incorrectly
 * reject back-to-back bookings.
 *
 * This module is deliberately free of any database, HTTP or framework
 * dependency so that it can be unit tested exhaustively and reused by both the
 * availability query and the booking transaction. The database exclusion
 * constraint in schema.sql enforces the same predicate structurally.
 */

/** A half-open interval of instants, [start, end). */
export interface Interval {
  start: Date
  end: Date
}

/** Thrown when an interval is malformed rather than merely conflicting. */
export class InvalidIntervalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidIntervalError'
  }
}

/**
 * Validates that an interval is well formed.
 *
 * An end equal to the start is rejected: a zero-length interval occupies no
 * time, so accepting one would create bookings that are invisible to the
 * overlap check yet still consume a reference number.
 */
export function assertValidInterval(interval: Interval): void {
  const startMs = interval.start.getTime()
  const endMs = interval.end.getTime()

  if (Number.isNaN(startMs)) {
    throw new InvalidIntervalError('Start time is not a valid date')
  }
  if (Number.isNaN(endMs)) {
    throw new InvalidIntervalError('End time is not a valid date')
  }
  if (endMs <= startMs) {
    throw new InvalidIntervalError('End time must be later than start time')
  }
}

/**
 * The core predicate: do two half-open intervals share any instant?
 *
 * Returns true when they conflict. Pure, total, and allocation-free.
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && a.end.getTime() > b.start.getTime()
}

/**
 * Overlap test that additionally enforces a transition buffer.
 *
 * A facility with `bufferMinutes = 15` requires a 15-minute gap between
 * consecutive bookings, so that a room can be vacated and prepared. The buffer
 * widens the comparison on both sides:
 *
 *     a.start < b.end + buffer   AND   a.end + buffer > b.start
 *
 * With buffer = 0 this reduces exactly to `intervalsOverlap`, so there is a
 * single code path and no chance of the two rules drifting apart.
 *
 * NOTE ON THE DATABASE CONSTRAINT: the exclusion constraint in schema.sql
 * enforces plain overlap only - SQL can express "no intersection" but not "no
 * intersection and at least N minutes apart". Buffers are therefore enforced
 * here, inside the booking transaction, which locks the facility row. The
 * constraint remains the backstop.
 */
export function intervalsConflictWithBuffer(
  a: Interval,
  b: Interval,
  bufferMinutes: number,
): boolean {
  if (bufferMinutes < 0) {
    throw new InvalidIntervalError('Buffer minutes cannot be negative')
  }

  const bufferMs = bufferMinutes * 60_000

  return (
    a.start.getTime() < b.end.getTime() + bufferMs &&
    a.end.getTime() + bufferMs > b.start.getTime()
  )
}

/**
 * Returns the first existing interval that conflicts with `candidate`, or null
 * when the candidate is clear.
 *
 * Returning the offending interval rather than a boolean is what lets the API
 * tell a user *which* booking blocked them ("Networking Lab A is already booked
 * 14:00-16:00") instead of a bare rejection. Vague errors are the main reason
 * users cannot resolve their own booking failures.
 */
export function findFirstConflict<T extends Interval>(
  candidate: Interval,
  existing: readonly T[],
  bufferMinutes = 0,
): T | null {
  for (const item of existing) {
    if (intervalsConflictWithBuffer(candidate, item, bufferMinutes)) {
      return item
    }
  }
  return null
}

/**
 * Subtracts a set of busy intervals from a day window, yielding the free
 * intervals in ascending order.
 *
 * Used to build the availability view. The result is merged and normalised, so
 * overlapping busy periods (a booking and a maintenance block covering the same
 * hours) do not produce duplicate or inverted free slots.
 *
 * Assumes `busy` intervals are already validated. Invalid ones are ignored
 * rather than throwing, because the availability view should degrade to showing
 * *something* rather than failing entirely for a user.
 */
export function subtractIntervals(window: Interval, busy: readonly Interval[]): Interval[] {
  const valid = busy
    .filter(
      (item) =>
        !Number.isNaN(item.start.getTime()) &&
        !Number.isNaN(item.end.getTime()) &&
        item.end.getTime() > item.start.getTime(),
    )
    .filter(
      (item) =>
        item.start.getTime() < window.end.getTime() &&
        item.end.getTime() > window.start.getTime(),
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  const free: Interval[] = []
  let cursor = window.start

  for (const item of valid) {
    // Only emit a gap when it has positive length. Touching intervals
    // (free slot ending exactly when the next busy period begins) must not
    // produce a zero-length entry.
    if (item.start.getTime() > cursor.getTime()) {
      free.push({ start: cursor, end: new Date(item.start.getTime()) })
    }
    if (item.end.getTime() > cursor.getTime()) {
      cursor = item.end
    }
  }

  if (cursor.getTime() < window.end.getTime()) {
    free.push({ start: cursor, end: window.end })
  }

  return free
}
