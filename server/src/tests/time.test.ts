/**
 * Unit tests for campus time handling.
 *
 * The most important test here is `the fixed UTC+3 offset assumption holds`.
 * The entire conversion strategy rests on Africa/Nairobi never observing DST.
 * If that were ever untrue, bookings would silently shift by an hour - a bug
 * that would be invisible in casual testing and catastrophic in a demo.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  combineLocalDateTimeToUtc,
  toLocalTimeString,
  toLocalDateString,
  endOfLocalDayUtc,
  startOfLocalDayUtc,
  addMinutes,
  minutesBetween,
  durationMinutes,
  isWithinOperatingHours,
  localDayOfWeek,
  assertCampusOffsetIsStable,
  formatLocalDateForDisplay,
  InvalidDateTimeError,
  CAMPUS_UTC_OFFSET_MINUTES,
} from '../lib/time.ts'

describe('campus timezone assumptions', () => {
  test('the fixed UTC+3 offset assumption holds', () => {
    // Asks Intl for the real offset in both halves of the year. Throws if the
    // fixed-offset strategy in time.ts is no longer valid.
    assert.equal(assertCampusOffsetIsStable(), CAMPUS_UTC_OFFSET_MINUTES)
  })
})

describe('combineLocalDateTimeToUtc', () => {
  test('converts Nairobi 14:00 to 11:00 UTC', () => {
    const instant = combineLocalDateTimeToUtc('2026-10-14', '14:00')
    assert.equal(instant.toISOString(), '2026-10-14T11:00:00.000Z')
  })

  test('converts Nairobi midnight to 21:00 UTC on the previous day', () => {
    const instant = combineLocalDateTimeToUtc('2026-10-14', '00:00')
    assert.equal(instant.toISOString(), '2026-10-13T21:00:00.000Z')
  })

  test('converts Nairobi 23:59 to 20:59 UTC', () => {
    const instant = combineLocalDateTimeToUtc('2026-10-14', '23:59')
    assert.equal(instant.toISOString(), '2026-10-14T20:59:00.000Z')
  })

  test('round-trips a local date and time', () => {
    const instant = combineLocalDateTimeToUtc('2026-03-01', '09:30')
    assert.equal(toLocalDateString(instant), '2026-03-01')
    assert.equal(toLocalTimeString(instant), '09:30')
  })

  test('handles a leap day', () => {
    const instant = combineLocalDateTimeToUtc('2028-02-29', '10:00')
    assert.equal(toLocalDateString(instant), '2028-02-29')
  })

  test('rejects a day that does not exist in the given month', () => {
    // Date.UTC would silently roll this into 2 or 3 March; we must not.
    assert.throws(() => combineLocalDateTimeToUtc('2026-02-31', '10:00'), InvalidDateTimeError)
  })

  test('rejects 31 April', () => {
    assert.throws(() => combineLocalDateTimeToUtc('2026-04-31', '10:00'), InvalidDateTimeError)
  })

  test('rejects a non-leap 29 February', () => {
    assert.throws(() => combineLocalDateTimeToUtc('2026-02-29', '10:00'), InvalidDateTimeError)
  })

  test('rejects month 13', () => {
    assert.throws(() => combineLocalDateTimeToUtc('2026-13-01', '10:00'), InvalidDateTimeError)
  })

  test('rejects hour 24', () => {
    assert.throws(() => combineLocalDateTimeToUtc('2026-10-14', '24:00'), InvalidDateTimeError)
  })

  test('rejects minute 60', () => {
    assert.throws(() => combineLocalDateTimeToUtc('2026-10-14', '10:60'), InvalidDateTimeError)
  })

  test('rejects a malformed date string', () => {
    assert.throws(() => combineLocalDateTimeToUtc('14/10/2026', '10:00'), InvalidDateTimeError)
  })

  test('rejects a malformed time string', () => {
    assert.throws(() => combineLocalDateTimeToUtc('2026-10-14', '2pm'), InvalidDateTimeError)
  })
})

describe('day boundaries', () => {
  test('a local day starts at 21:00 UTC the previous day', () => {
    assert.equal(startOfLocalDayUtc('2026-10-14').toISOString(), '2026-10-13T21:00:00.000Z')
  })

  test('a local day ends exactly 24 hours after it starts', () => {
    const start = startOfLocalDayUtc('2026-10-14')
    const end = endOfLocalDayUtc('2026-10-14')
    assert.equal(minutesBetween(start, end), 24 * 60)
  })

  test('the end of one day equals the start of the next (no gap, no overlap)', () => {
    assert.equal(endOfLocalDayUtc('2026-10-14').toISOString(), startOfLocalDayUtc('2026-10-15').toISOString())
  })
})

describe('arithmetic helpers', () => {
  test('addMinutes shifts forward and backward', () => {
    const base = new Date('2026-10-14T11:00:00.000Z')
    assert.equal(addMinutes(base, 90).toISOString(), '2026-10-14T12:30:00.000Z')
    assert.equal(addMinutes(base, -60).toISOString(), '2026-10-14T10:00:00.000Z')
  })

  test('durationMinutes reports whole minutes', () => {
    const start = combineLocalDateTimeToUtc('2026-10-14', '14:00')
    const end = combineLocalDateTimeToUtc('2026-10-14', '15:30')
    assert.equal(durationMinutes(start, end), 90)
  })
})

describe('isWithinOperatingHours', () => {
  test('accepts an interval comfortably inside the window', () => {
    const start = combineLocalDateTimeToUtc('2026-10-14', '10:00')
    assert.equal(isWithinOperatingHours(start, addMinutes(start, 60), '08:00', '18:00'), true)
  })

  test('accepts an interval starting exactly at opening time', () => {
    const start = combineLocalDateTimeToUtc('2026-10-14', '08:00')
    assert.equal(isWithinOperatingHours(start, addMinutes(start, 60), '08:00', '18:00'), true)
  })

  test('accepts an interval ending exactly at closing time', () => {
    const end = combineLocalDateTimeToUtc('2026-10-14', '18:00')
    assert.equal(isWithinOperatingHours(addMinutes(end, -60), end, '08:00', '18:00'), true)
  })

  test('rejects an interval starting before opening time', () => {
    const start = combineLocalDateTimeToUtc('2026-10-14', '07:30')
    assert.equal(isWithinOperatingHours(start, addMinutes(start, 60), '08:00', '18:00'), false)
  })

  test('rejects an interval ending after closing time', () => {
    const start = combineLocalDateTimeToUtc('2026-10-14', '17:30')
    assert.equal(isWithinOperatingHours(start, addMinutes(start, 60), '08:00', '18:00'), false)
  })

  test('rejects an interval one minute past closing time', () => {
    const end = combineLocalDateTimeToUtc('2026-10-14', '18:01')
    assert.equal(isWithinOperatingHours(addMinutes(end, -60), end, '08:00', '18:00'), false)
  })
})

describe('local calendar helpers', () => {
  test('resolves the local weekday correctly across the UTC date boundary', () => {
    // 2026-10-13 is a Tuesday. At 21:30 UTC it is already Wednesday locally.
    assert.equal(localDayOfWeek(new Date('2026-10-13T21:30:00.000Z')), 3)
    // At 20:30 UTC it is still Tuesday locally.
    assert.equal(localDayOfWeek(new Date('2026-10-13T20:30:00.000Z')), 2)
  })

  test('formats a local date for people', () => {
    const formatted = formatLocalDateForDisplay('2026-10-14')
    assert.match(formatted, /Wednesday/)
    assert.match(formatted, /14/)
    assert.match(formatted, /October/)
    assert.match(formatted, /2026/)
  })
})
