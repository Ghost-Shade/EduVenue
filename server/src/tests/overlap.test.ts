/**
 * Unit tests for the interval overlap logic.
 *
 * These run against pure functions with no database and no HTTP, so they are
 * fast and they isolate the single most important rule in the application:
 * two confirmed bookings must never overlap for the same facility.
 *
 * The cases marked "brief" are the exact examples specified in the project
 * requirements, including the boundary cases that must be ALLOWED.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  intervalsOverlap,
  intervalsConflictWithBuffer,
  findFirstConflict,
  subtractIntervals,
  assertValidInterval,
  InvalidIntervalError,
  type Interval,
} from '../lib/overlap.ts'

/** Builds an interval from two ISO strings. */
function at(startIso: string, endIso: string): Interval {
  return { start: new Date(startIso), end: endIso === '' ? new Date(NaN) : new Date(endIso) }
}

// A convenient reference morning. Absolute values are irrelevant to the
// predicate; only the relationships between the intervals matter.
const B = '2026-10-14T'
const twoPm = at(`${B}14:00:00.000Z`, `${B}16:00:00.000Z`)

describe('intervalsOverlap - the core half-open predicate', () => {
  test('brief: 14:00-16:00 rejects 15:00-17:00 (partial overlap at the end)', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}15:00:00.000Z`, `${B}17:00:00.000Z`)), true)
  })

  test('brief: 14:00-16:00 rejects 13:00-15:00 (partial overlap at the start)', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}13:00:00.000Z`, `${B}15:00:00.000Z`)), true)
  })

  test('brief: 14:00-16:00 ALLOWS 16:00-17:00 (back-to-back, touching end)', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}16:00:00.000Z`, `${B}17:00:00.000Z`)), false)
  })

  test('brief: 14:00-16:00 ALLOWS 13:00-14:00 (back-to-back, touching start)', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}13:00:00.000Z`, `${B}14:00:00.000Z`)), false)
  })

  test('rejects an identical interval', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}14:00:00.000Z`, `${B}16:00:00.000Z`)), true)
  })

  test('rejects a fully contained interval', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}14:30:00.000Z`, `${B}15:00:00.000Z`)), true)
  })

  test('rejects an interval that fully contains the reference', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}13:00:00.000Z`, `${B}17:00:00.000Z`)), true)
  })

  test('allows an entirely earlier interval', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}09:00:00.000Z`, `${B}11:00:00.000Z`)), false)
  })

  test('allows an entirely later interval', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}18:00:00.000Z`, `${B}20:00:00.000Z`)), false)
  })

  test('allows an interval separated by a one-minute gap', () => {
    assert.equal(intervalsOverlap(twoPm, at(`${B}16:01:00.000Z`, `${B}17:00:00.000Z`)), false)
  })

  test('is symmetric - overlap(a,b) equals overlap(b,a)', () => {
    const other = at(`${B}15:00:00.000Z`, `${B}17:00:00.000Z`)
    assert.equal(intervalsOverlap(twoPm, other), intervalsOverlap(other, twoPm))
  })
})

describe('intervalsConflictWithBuffer - transition gaps', () => {
  test('a zero buffer behaves exactly like plain overlap', () => {
    const cases: Array<[string, string, string, string]> = [
      [`${B}15:00:00.000Z`, `${B}17:00:00.000Z`, `${B}14:00:00.000Z`, `${B}16:00:00.000Z`],
      [`${B}16:00:00.000Z`, `${B}17:00:00.000Z`, `${B}14:00:00.000Z`, `${B}16:00:00.000Z`],
      [`${B}13:00:00.000Z`, `${B}14:00:00.000Z`, `${B}14:00:00.000Z`, `${B}16:00:00.000Z`],
    ]

    for (const [aStart, aEnd, bStart, bEnd] of cases) {
      const a = at(aStart, aEnd)
      const b = at(bStart, bEnd)
      assert.equal(
        intervalsConflictWithBuffer(a, b, 0),
        intervalsOverlap(a, b),
        `mismatch for ${aStart}-${aEnd} vs ${bStart}-${bEnd}`,
      )
    }
  })

  test('a 15-minute buffer makes a back-to-back booking conflict', () => {
    // 14:00-16:00 then 16:00-17:00 touches exactly. With a preparation gap
    // required, this must now be rejected.
    assert.equal(
      intervalsConflictWithBuffer(twoPm, at(`${B}16:00:00.000Z`, `${B}17:00:00.000Z`), 15),
      true,
    )
  })

  test('a 15-minute buffer still allows a booking 15 minutes later', () => {
    assert.equal(
      intervalsConflictWithBuffer(twoPm, at(`${B}16:15:00.000Z`, `${B}17:00:00.000Z`), 15),
      false,
    )
  })

  test('a 15-minute buffer affects the earlier side too', () => {
    // 13:00-14:00 touches the reference at 14:00 and must now be rejected.
    assert.equal(
      intervalsConflictWithBuffer(twoPm, at(`${B}13:00:00.000Z`, `${B}14:00:00.000Z`), 15),
      true,
    )
  })

  test('a negative buffer is rejected as invalid input', () => {
    assert.throws(
      () => intervalsConflictWithBuffer(twoPm, at(`${B}18:00:00.000Z`, `${B}19:00:00.000Z`), -5),
      InvalidIntervalError,
    )
  })
})

describe('assertValidInterval - malformed input', () => {
  test('rejects an interval whose end precedes its start', () => {
    assert.throws(
      () => assertValidInterval(at(`${B}16:00:00.000Z`, `${B}14:00:00.000Z`)),
      InvalidIntervalError,
    )
  })

  test('rejects a zero-length interval', () => {
    assert.throws(
      () => assertValidInterval(at(`${B}14:00:00.000Z`, `${B}14:00:00.000Z`)),
      InvalidIntervalError,
    )
  })

  test('rejects an unparseable date', () => {
    assert.throws(() => assertValidInterval(at('not-a-date', `${B}15:00:00.000Z`)), InvalidIntervalError)
  })

  test('accepts a well-formed interval', () => {
    assert.doesNotThrow(() => assertValidInterval(twoPm))
  })
})

describe('findFirstConflict - reporting which booking blocked a request', () => {
  test('returns null when nothing conflicts', () => {
    const existing = [at(`${B}09:00:00.000Z`, `${B}11:00:00.000Z`)]
    assert.equal(findFirstConflict(twoPm, existing), null)
  })

  test('returns the offending booking so the user can be told why', () => {
    const blocking = at(`${B}15:00:00.000Z`, `${B}17:00:00.000Z`)
    const existing = [at(`${B}09:00:00.000Z`, `${B}11:00:00.000Z`), blocking]
    assert.equal(findFirstConflict(twoPm, existing), blocking)
  })

  test('honours the buffer when searching', () => {
    const existing = [at(`${B}16:00:00.000Z`, `${B}17:00:00.000Z`)]
    assert.equal(findFirstConflict(twoPm, existing, 0), null)
    assert.notEqual(findFirstConflict(twoPm, existing, 15), null)
  })
})

describe('subtractIntervals - building the availability view', () => {
  const day: Interval = at(`${B}08:00:00.000Z`, `${B}18:00:00.000Z`)

  test('with no busy periods the whole window is free', () => {
    const free = subtractIntervals(day, [])
    assert.equal(free.length, 1)
    assert.equal(free[0]?.start.toISOString(), day.start.toISOString())
    assert.equal(free[0]?.end.toISOString(), day.end.toISOString())
  })

  test('splits the window around a midday booking', () => {
    const free = subtractIntervals(day, [at(`${B}12:00:00.000Z`, `${B}14:00:00.000Z`)])
    assert.equal(free.length, 2)
    assert.equal(free[0]?.start.toISOString(), `${B}08:00:00.000Z`)
    assert.equal(free[0]?.end.toISOString(), `${B}12:00:00.000Z`)
    assert.equal(free[1]?.start.toISOString(), `${B}14:00:00.000Z`)
    assert.equal(free[1]?.end.toISOString(), `${B}18:00:00.000Z`)
  })

  test('merges overlapping busy periods instead of producing inverted gaps', () => {
    const free = subtractIntervals(day, [
      at(`${B}12:00:00.000Z`, `${B}14:00:00.000Z`),
      at(`${B}13:00:00.000Z`, `${B}15:00:00.000Z`),
    ])
    assert.equal(free.length, 2)
    assert.equal(free[1]?.start.toISOString(), `${B}15:00:00.000Z`)
  })

  test('ignores busy periods entirely outside the window', () => {
    const free = subtractIntervals(day, [at(`${B}20:00:00.000Z`, `${B}22:00:00.000Z`)])
    assert.equal(free.length, 1)
  })

  test('does not emit a zero-length slot when a busy period starts at the window start', () => {
    const free = subtractIntervals(day, [at(`${B}08:00:00.000Z`, `${B}10:00:00.000Z`)])
    assert.equal(free.length, 1)
    assert.ok(free[0]!.end.getTime() > free[0]!.start.getTime())
  })

  test('produces no free slots when the window is fully occupied', () => {
    assert.deepEqual(subtractIntervals(day, [at(`${B}07:00:00.000Z`, `${B}19:00:00.000Z`)]), [])
  })

  test('clips a busy period that spills past both ends of the window', () => {
    const free = subtractIntervals(day, [at(`${B}06:00:00.000Z`, `${B}20:00:00.000Z`)])
    assert.deepEqual(free, [])
  })

  test('every returned slot has positive duration', () => {
    const free = subtractIntervals(day, [
      at(`${B}09:00:00.000Z`, `${B}10:00:00.000Z`),
      at(`${B}11:00:00.000Z`, `${B}12:00:00.000Z`),
      at(`${B}15:00:00.000Z`, `${B}16:00:00.000Z`),
    ])
    for (const slot of free) {
      assert.ok(slot.end.getTime() > slot.start.getTime(), 'slot must have positive length')
    }
  })
})
