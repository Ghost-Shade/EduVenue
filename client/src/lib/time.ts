/**
 * Campus time formatting, for display only.
 *
 * The server owns every conversion between local wall-clock time and instants.
 * The client never converts a user's input into a timestamp - it sends the date
 * and the two local times as strings, and the server decides what instant those
 * denote. That is deliberate: two implementations of the same rule is two
 * chances to disagree, and a disagreement here means a booking at the wrong
 * hour.
 *
 * What this module does is purely presentational: turn a stored UTC instant
 * into a Nairobi wall-clock string. Formatting with an explicit `timeZone`
 * means a judge viewing the demo from another country still sees campus times.
 */

export const CAMPUS_TIMEZONE = 'Africa/Nairobi'

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "Tue 14 Oct 2026, 09:00" */
export function formatInstant(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMPUS_TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

/** "Tuesday, 14 October 2026" from an instant. */
export function formatInstantDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMPUS_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso))
}

/** "09:00" from an instant. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CAMPUS_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

/** "09:00 - 11:00" for a booking. */
export function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)} - ${formatTime(endIso)}`
}

/** Local `YYYY-MM-DD` for an instant. Used to group bookings by campus day. */
export function toLocalDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAMPUS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/** Today's local date, in `YYYY-MM-DD`. */
export function todayLocalDate(): string {
  return toLocalDate(new Date().toISOString())
}

/**
 * Shifts a `YYYY-MM-DD` date by whole days.
 *
 * Uses `Date.UTC`, which normalises month and year overflow correctly, so
 * month-end arithmetic does not produce an impossible date.
 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))

  const pad = (value: number) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** "Tuesday 14 October" from a `YYYY-MM-DD` date. */
export function formatLocalDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  // Midday avoids any chance of the boundary being crossed during formatting.
  const midday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0))

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(midday)
}

/** "Tuesday 14 October 2026" from a `YYYY-MM-DD` date. */
export function formatLocalDateLong(date: string): string {
  return `${formatLocalDate(date)} ${date.slice(0, 4)}`
}

/** Weekday index (0 = Sunday) for a `YYYY-MM-DD` date. */
export function localWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0)).getUTCDay()
}

/** "Sunday", "Monday", ... for a `YYYY-MM-DD` date. */
export function weekdayName(date: string): string {
  return WEEKDAY_LONG[localWeekday(date)] ?? ''
}

/** "2 hours", "1 hour 30 minutes", "45 minutes". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`

  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60

  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`
  return remainder === 0 ? hourPart : `${hourPart} ${remainder} minutes`
}

/** True when the instant is in the past. */
export function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now()
}

/** True when an instant falls on today's campus date. */
export function isToday(iso: string): boolean {
  return toLocalDate(iso) === todayLocalDate()
}

/** "Today", "Tomorrow", or "Tuesday 14 October". */
export function describeDay(iso: string): string {
  const date = toLocalDate(iso)
  const today = todayLocalDate()

  if (date === today) return 'Today'
  if (date === addDays(today, 1)) return 'Tomorrow'
  if (date === addDays(today, -1)) return 'Yesterday'

  return formatLocalDate(date)
}
