/**
 * Campus time handling.
 *
 * ===========================================================================
 * THE TIME MODEL - read before touching any date or time logic
 * ===========================================================================
 *
 * Storage:      every instant is stored in PostgreSQL as `timestamptz` in UTC.
 * Display:      every instant is rendered in Africa/Nairobi.
 * Input:        the UI collects local Nairobi wall-clock date + time.
 *
 * Africa/Nairobi is East Africa Time, UTC+3, and has observed no daylight
 * saving since 1942. That means the offset is a genuine constant, so we can
 * convert with simple arithmetic instead of a timezone database lookup. It also
 * means there is no DST transition to produce a nonexistent or duplicated local
 * time - the classic source of booking bugs.
 *
 * `assertCampusOffsetIsStable()` below proves this assumption at test time
 * rather than trusting the comment. If the offset ever changed, a test fails
 * instead of bookings silently shifting by an hour.
 *
 * Operating hours (`opensAt`, `closesAt`) are LOCAL wall-clock strings of the
 * form "HH:MM", because "the lab opens at 08:00" is a local statement, not an
 * instant. Every other exported value is a real `Date` representing an instant.
 */

/** IANA identifier of the campus timezone. Used for display formatting. */
export const CAMPUS_TIMEZONE = 'Africa/Nairobi'

/** East Africa Time is UTC+3. See the DST note above. */
export const CAMPUS_UTC_OFFSET_MINUTES = 180

const MINUTE_MS = 60_000

/** Local date in `YYYY-MM-DD` form. */
export type LocalDateString = string

/** Local wall-clock time in 24-hour `HH:MM` form. */
export type LocalTimeString = string

/** An instant in UTC. */
export type UtcInstant = Date

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^(\d{2}):(\d{2})$/

/** Thrown when a caller supplies a date or time that is not well formed. */
export class InvalidDateTimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDateTimeError'
  }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * Parses `YYYY-MM-DD` into calendar parts, rejecting impossible dates.
 *
 * `Date.UTC` silently normalises out-of-range values (month 13 rolls into
 * January of the next year, 31 February becomes 2 or 3 March). For a booking
 * system that silence is dangerous, so we round-trip and compare.
 */
function parseLocalDate(date: LocalDateString): {
  year: number
  month: number
  day: number
} {
  const match = DATE_PATTERN.exec(date.trim())
  if (!match) {
    throw new InvalidDateTimeError(
      `Date must be in YYYY-MM-DD format, received "${date}"`,
    )
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (month < 1 || month > 12) {
    throw new InvalidDateTimeError(`Month must be between 01 and 12, received "${date}"`)
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) {
    throw new InvalidDateTimeError(
      `Day ${day} does not exist in month ${pad(month)} of ${year}`,
    )
  }

  return { year, month, day }
}

/** Parses a 24-hour `HH:MM` local time. */
function parseLocalTime(time: LocalTimeString): {
  hours: number
  minutes: number
} {
  const match = TIME_PATTERN.exec(time.trim())
  if (!match) {
    throw new InvalidDateTimeError(
      `Time must be in 24-hour HH:MM format, received "${time}"`,
    )
  }

  const hours = Number(match[1])
  const minutes = Number(match[2])

  if (hours > 23) {
    throw new InvalidDateTimeError(`Hour must be between 00 and 23, received "${time}"`)
  }
  if (minutes > 59) {
    throw new InvalidDateTimeError(`Minute must be between 00 and 59, received "${time}"`)
  }

  return { hours, minutes }
}

/**
 * Converts a local Nairobi date + time into the UTC instant it denotes.
 *
 * This is the only place local wall-clock input becomes an instant. Every
 * booking start and end passes through here.
 */
export function combineLocalDateTimeToUtc(
  date: LocalDateString,
  time: LocalTimeString,
): UtcInstant {
  const { year, month, day } = parseLocalDate(date)
  const { hours, minutes } = parseLocalTime(time)

  // Treat the wall-clock as if it were UTC, then subtract the campus offset.
  const asIfUtc = Date.UTC(year, month - 1, day, hours, minutes, 0, 0)
  return new Date(asIfUtc - CAMPUS_UTC_OFFSET_MINUTES * MINUTE_MS)
}

/** Shifts an instant by a whole number of minutes. */
export function addMinutes(instant: UtcInstant, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS)
}

/** Inclusive whole minutes from `from` to `to`. Negative when `to` is earlier. */
export function minutesBetween(from: UtcInstant, to: UtcInstant): number {
  return Math.round((to.getTime() - from.getTime()) / MINUTE_MS)
}

/** Duration of an interval, in whole minutes. */
export function durationMinutes(start: UtcInstant, end: UtcInstant): number {
  return minutesBetween(start, end)
}

// ---------------------------------------------------------------------------
// Display helpers
//
// All of these use Intl with an explicit timeZone rather than getHours() and
// friends. The browser's own timezone is therefore irrelevant: a judge opening
// the demo from another country still sees Nairobi times.
// ---------------------------------------------------------------------------

/** Formats an instant as a local `YYYY-MM-DD` date. */
export function toLocalDateString(instant: UtcInstant): LocalDateString {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAMPUS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
  return parts
}

/** Formats an instant as a local 24-hour `HH:MM` time. */
export function toLocalTimeString(instant: UtcInstant): LocalTimeString {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMPUS_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant)
}

/** Formats an instant for people, e.g. "Tue 14 Oct 2026, 14:00". */
export function formatForDisplay(instant: UtcInstant): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMPUS_TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant)
}

/** Formats a local date string for people, e.g. "Tuesday, 14 October 2026". */
export function formatLocalDateForDisplay(date: LocalDateString): string {
  const { year, month, day } = parseLocalDate(date)
  const noonUtc = new Date(
    Date.UTC(year, month - 1, day, 12, 0, 0, 0) - CAMPUS_UTC_OFFSET_MINUTES * MINUTE_MS,
  )
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMPUS_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(noonUtc)
}

/** Weekday index in local terms: 0 = Sunday .. 6 = Saturday. */
export function localDayOfWeek(instant: UtcInstant): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMPUS_TIMEZONE,
    weekday: 'short',
  }).format(instant)
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name)
  if (index === -1) {
    throw new Error(`Unable to resolve weekday for ${instant.toISOString()}`)
  }
  return index
}

/** Local calendar date of an instant, as `YYYY-MM-DD`, without formatting overhead. */
export function localDateOf(instant: UtcInstant): LocalDateString {
  return toLocalDateString(instant)
}

/**
 * The UTC instant at which a local calendar day begins (00:00 local).
 * Used to build day-scoped availability queries.
 */
export function startOfLocalDayUtc(date: LocalDateString): UtcInstant {
  return combineLocalDateTimeToUtc(date, '00:00')
}

/**
 * The UTC instant at which a local calendar day ends, EXCLUSIVE (24:00 local,
 * which is 00:00 of the following day). Used as the upper bound of a half-open
 * day range, so a booking ending at 00:00 does not leak into the next day.
 */
export function endOfLocalDayUtc(date: LocalDateString): UtcInstant {
  const start = startOfLocalDayUtc(date)
  return addMinutes(start, 24 * 60)
}

/** Parses an `HH:MM` operating-hours value into minutes past local midnight. */
export function parseOperatingHoursToMinutes(value: LocalTimeString): number {
  const { hours, minutes } = parseLocalTime(value)
  return hours * 60 + minutes
}

/**
 * Shifts a local `YYYY-MM-DD` date by whole days.
 *
 * Month, year and leap-year boundaries are handled by `Date.UTC`, which
 * normalises overflow. A hand-rolled implementation that added to the day
 * component alone would produce "2026-02-31" style nonsense.
 */
export function addDaysToLocalDate(date: LocalDateString, days: number): LocalDateString {
  const { year, month, day } = parseLocalDate(date)

  const shifted = new Date(Date.UTC(year, month - 1, day + days))

  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** Minutes past local midnight for an instant. */
export function minutesPastLocalMidnight(instant: UtcInstant): number {
  const time = toLocalTimeString(instant)
  const [hours, minutes] = time.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/**
 * Checks that an interval lies within a facility's operating window, evaluated
 * in local terms.
 *
 * Both bounds are compared as minutes past local midnight. Because the
 * facility window never crosses midnight (enforced by a CHECK constraint in
 * the schema), a simple numeric comparison is sufficient and an interval
 * ending exactly at closing time is allowed.
 */
export function isWithinOperatingHours(
  start: UtcInstant,
  end: UtcInstant,
  opensAt: LocalTimeString,
  closesAt: LocalTimeString,
): boolean {
  const opening = parseOperatingHoursToMinutes(opensAt)
  const closing = parseOperatingHoursToMinutes(closesAt)

  const startMinutes = minutesPastLocalMidnight(start)
  const endMinutes = minutesPastLocalMidnight(end)

  return startMinutes >= opening && endMinutes <= closing
}

/**
 * Asserts the fixed-offset assumption still holds, by asking Intl for the real
 * offset of Africa/Nairobi. Called from the test suite.
 *
 * Returns the observed offset in minutes, or throws if it disagrees with
 * CAMPUS_UTC_OFFSET_MINUTES.
 */
export function assertCampusOffsetIsStable(): number {
  // Pick an instant in each half of the year so a DST rule, if one were ever
  // introduced, would show up in one of them.
  const probes = [
    new Date('2026-01-15T12:00:00Z'),
    new Date('2026-07-15T12:00:00Z'),
  ]

  for (const probe of probes) {
    const local = toLocalTimeString(probe)
    const expected = new Date(
      probe.getTime() + CAMPUS_UTC_OFFSET_MINUTES * MINUTE_MS,
    )
    const expectedLocal = `${pad(expected.getUTCHours())}:${pad(expected.getUTCMinutes())}`

    if (local !== expectedLocal) {
      throw new Error(
        `Africa/Nairobi offset assumption is wrong: expected ${expectedLocal}, got ${local}. ` +
          'The fixed-offset conversion in time.ts must be replaced with a timezone-aware one.',
      )
    }
  }

  return CAMPUS_UTC_OFFSET_MINUTES
}
