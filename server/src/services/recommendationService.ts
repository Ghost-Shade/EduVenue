/**
 * Facility recommendation engine.
 *
 * ===========================================================================
 * THIS IS NOT AI, AND MUST NOT BE DESCRIBED AS AI
 * ===========================================================================
 *
 * It is deterministic, rule-based filtering and scoring. The same request
 * always produces the same answer, every result can be explained, and there is
 * no model, no training data and no inference. Calling it "AI-powered" would be
 * a false claim, and the brief explicitly forbids it. The honest description is
 * "a rules-based matcher" - which is a strength here, because a booking
 * recommendation that cannot explain itself is worse than useless.
 *
 * ===========================================================================
 * IT SHARES THE BOOKING RULES RATHER THAN COPYING THEM
 * ===========================================================================
 *
 * Every candidate is checked with `evaluateBookingRequest` from the booking
 * service - the same functions the booking transaction calls. A second copy of
 * the rules would drift, and the failure mode would be the application offering
 * a slot and then refusing to book it.
 *
 * It never invents availability. When nothing matches, it either suggests a
 * specific different time that IS free, or says plainly that it found nothing.
 */
import { roleAtLeast, type UserRole } from '../lib/roles.ts'
import {
  addDaysToLocalDate,
  addMinutes,
  combineLocalDateTimeToUtc,
  durationMinutes,
  formatForDisplay,
  toLocalDateString,
  type LocalDateString,
} from '../lib/time.ts'
import type { AuthenticatedUser } from './sessionService.ts'
import { evaluateBookingRequest } from './bookingService.ts'
import { listFacilities, type FacilityRecord } from './facilityService.ts'

export interface RecommendationInput {
  date: LocalDateString
  startTime: string
  endTime: string
  expectedAttendance: number
  activityPurpose: string
  preferredCategoryId?: string | undefined
  preferredBuilding?: string | undefined
  requiredEquipment?: string[] | undefined
}

export interface Recommendation {
  facility: FacilityRecord
  score: number
  reasons: string[]
  /** attendance / capacity, as a percentage. Higher means a tighter fit. */
  capacityFitPercent: number
}

/** A facility that was considered and excluded, with the reason. */
export interface Rejection {
  facilityId: string
  facilityName: string
  code: string
  reason: string
}

/** A concrete, verified-free alternative time. */
export interface AlternativeSuggestion {
  facilityId: string
  facilityName: string
  building: string
  date: LocalDateString
  startTime: string
  endTime: string
  displayDate: string
  note: string
}

export interface RecommendationResult {
  requested: {
    date: LocalDateString
    startTime: string
    endTime: string
    durationMinutes: number
    expectedAttendance: number
    activityPurpose: string
  }
  recommendations: Recommendation[]
  /** How many facilities existed to consider, so an empty result is explicable. */
  consideredCount: number
  rejected: Rejection[]
  alternatives: AlternativeSuggestion[]
  /**
   * Set when the search could not be completed as asked, e.g. the requested
   * interval is invalid. The client should show this instead of "no results".
   */
  problem: string | null
}

// Scoring weights. Deliberately few, and each one is explainable to a user.
const WEIGHT_CAPACITY_FIT = 50
const WEIGHT_CATEGORY_MATCH = 25
const WEIGHT_BUILDING_MATCH = 25

/**
 * Cheap checks that need no database access: role, activity and capacity.
 *
 * Used to narrow the candidate list before the more expensive per-day
 * availability evaluation. Note these mirror rules that `evaluateBookingRequest`
 * also enforces - this is an OPTIMISATION, never the enforcement. The booking
 * path does not consult it.
 */
function passesCheapChecks(
  facility: FacilityRecord,
  actor: AuthenticatedUser,
  input: RecommendationInput,
): boolean {
  if (facility.status !== 'active') return false

  const isAdmin = actor.role === 'admin'
  if (!isAdmin && !roleAtLeast(actor.role, facility.minRole as UserRole)) return false
  if (facility.bookingPolicy === 'supervisor_required' && !isAdmin && actor.role !== 'supervisor') {
    return false
  }

  if (input.expectedAttendance > facility.capacity) return false

  if (facility.allowedActivities.length > 0) {
    const wanted = input.activityPurpose.trim().toLowerCase()
    const permitted = facility.allowedActivities.some(
      (activity) => activity.trim().toLowerCase() === wanted,
    )
    if (!permitted) return false
  }

  if (input.requiredEquipment && input.requiredEquipment.length > 0) {
    const owned = facility.equipment.map((item) => item.trim().toLowerCase())
    const missing = input.requiredEquipment.some(
      (required) => !owned.some((item) => item.includes(required.trim().toLowerCase())),
    )
    if (missing) return false
  }

  return true
}

/**
 * Scores a bookable facility and explains the score.
 *
 * Capacity fit dominates because an oversized venue is the most common way to
 * waste a booking: a 150-seat hall holding a 20-person revision session blocks
 * a hall that a large class needed. The fit is the ratio of attendees to seats,
 * so the tightest comfortable match ranks highest.
 */
function scoreFacility(
  facility: FacilityRecord,
  input: RecommendationInput,
  duration: number,
): Recommendation {
  const fitRatio = input.expectedAttendance / facility.capacity
  const capacityScore = WEIGHT_CAPACITY_FIT * fitRatio

  const reasons: string[] = []

  const capacityPercent = Math.round(fitRatio * 100)

  if (fitRatio >= 0.7) {
    reasons.push(
      `Holds ${facility.capacity} and you expect ${input.expectedAttendance} - a close fit, so it is not over-booked.`,
    )
  } else if (fitRatio >= 0.35) {
    reasons.push(
      `Holds ${facility.capacity} against ${input.expectedAttendance} expected - comfortable, with room to spare.`,
    )
  } else {
    reasons.push(
      `Holds ${facility.capacity}, which is much larger than the ${input.expectedAttendance} expected. ` +
        `Consider a smaller venue if one is free.`,
    )
  }

  let score = capacityScore

  if (input.preferredCategoryId && facility.categoryId === input.preferredCategoryId) {
    score += WEIGHT_CATEGORY_MATCH
    reasons.push(`In your preferred category, ${facility.categoryName}.`)
  }

  if (input.preferredBuilding && facility.building === input.preferredBuilding) {
    score += WEIGHT_BUILDING_MATCH
    reasons.push(`In your preferred building, ${facility.building}.`)
  }

  reasons.push(`Free for the whole ${duration} minutes you asked for.`)

  if (facility.bufferMinutes > 0) {
    reasons.push(
      `Note: ${facility.bufferMinutes} minutes of preparation time is required before and after bookings here.`,
    )
  }

  if (input.requiredEquipment && input.requiredEquipment.length > 0) {
    reasons.push(`Has the equipment you asked for: ${input.requiredEquipment.join(', ')}.`)
  }

  return {
    facility,
    score: Math.round(score * 10) / 10,
    reasons,
    capacityFitPercent: capacityPercent,
  }
}

/**
 * Finds concrete, verified-free alternatives near the requested time.
 *
 * Bounded on purpose: at most `maxResults` suggestions, at most `maxFacilities`
 * facilities and `maxDays` days. An unbounded search would be a cheap way for a
 * client to make the server do a lot of work.
 *
 * Every suggestion returned has passed the full booking rule set for that exact
 * facility, date and time, so it is one the user can actually act on.
 */
function findAlternatives(
  actor: AuthenticatedUser,
  input: RecommendationInput,
  candidates: FacilityRecord[],
  duration: number,
  today: LocalDateString,
  maxResults = 6,
  maxFacilities = 8,
  maxDays = 7,
): AlternativeSuggestion[] {
  const suggestions: AlternativeSuggestion[] = []

  for (const facility of candidates.slice(0, maxFacilities)) {
    for (let dayOffset = 0; dayOffset < maxDays; dayOffset += 1) {
      if (suggestions.length >= maxResults) return suggestions

      const date = addDaysToLocalDate(today, dayOffset)

      let start: Date
      let end: Date
      try {
        start = combineLocalDateTimeToUtc(date, input.startTime)
        end = combineLocalDateTimeToUtc(date, input.endTime)
      } catch {
        // An unparseable time would have been rejected before reaching here.
        continue
      }

      // Never suggest a time that has already passed today.
      if (start.getTime() <= Date.now()) continue

      const evaluation = evaluateBookingRequest({
        facility,
        actor,
        start,
        end,
        activityPurpose: input.activityPurpose,
        expectedAttendance: input.expectedAttendance,
        localDate: date,
      })

      if (!evaluation.bookable) continue

      suggestions.push({
        facilityId: facility.id,
        facilityName: facility.name,
        building: facility.building,
        date,
        startTime: input.startTime,
        endTime: input.endTime,
        displayDate: formatForDisplay(start),
        note:
          date === today
            ? `Free today at the same time.`
            : `Free at the same time on ${formatForDisplay(start).split(',')[0]}.`,
      })
    }
  }

  return suggestions
}

/**
 * Recommends facilities for a requested activity, time and attendance.
 *
 * Always returns an explanation: either ranked facilities with reasons, or the
 * specific rule each candidate failed, or concrete alternative times. A bare
 * "no results" is not an acceptable outcome for a user who is trying to find a
 * room.
 */
export function recommendFacilities(
  actor: AuthenticatedUser,
  input: RecommendationInput,
): RecommendationResult {
  const requested = {
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    durationMinutes: 0,
    expectedAttendance: input.expectedAttendance,
    activityPurpose: input.activityPurpose,
  }

  let start: Date
  let end: Date
  try {
    start = combineLocalDateTimeToUtc(input.date, input.startTime)
    end = combineLocalDateTimeToUtc(input.date, input.endTime)
  } catch (error) {
    return {
      requested,
      recommendations: [],
      consideredCount: 0,
      rejected: [],
      alternatives: [],
      problem: error instanceof Error ? error.message : 'The requested time could not be read.',
    }
  }

  const duration = durationMinutes(start, end)
  requested.durationMinutes = duration

  if (duration <= 0) {
    return {
      requested,
      recommendations: [],
      consideredCount: 0,
      rejected: [],
      alternatives: [],
      problem: 'The end time must be later than the start time.',
    }
  }

  const allFacilities = listFacilities()
  const candidates = allFacilities.filter((facility) =>
    passesCheapChecks(facility, actor, input),
  )

  const recommendations: Recommendation[] = []
  const rejected: Rejection[] = []

  for (const facility of candidates) {
    const evaluation = evaluateBookingRequest({
      facility,
      actor,
      start,
      end,
      activityPurpose: input.activityPurpose,
      expectedAttendance: input.expectedAttendance,
      localDate: input.date,
    })

    if (evaluation.bookable) {
      recommendations.push(scoreFacility(facility, input, duration))
    } else {
      rejected.push({
        facilityId: facility.id,
        facilityName: facility.name,
        code: evaluation.code ?? 'UNAVAILABLE',
        reason: evaluation.reason ?? 'Not available for the requested time.',
      })
    }
  }

  recommendations.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Stable tie-break so the same request always produces the same order.
    return a.facility.name.localeCompare(b.facility.name)
  })

  // Only offer alternatives when the direct request found nothing, so the
  // primary answer stays focused.
  const alternatives =
    recommendations.length === 0
      ? findAlternatives(actor, input, candidates, duration, toLocalDateString(new Date()))
      : []

  return {
    requested,
    recommendations,
    consideredCount: allFacilities.length,
    rejected,
    alternatives,
    problem: null,
  }
}

/** Re-exported so routes can compute an end time from a start plus a duration. */
export function endTimeFrom(start: Date, minutes: number): Date {
  return addMinutes(start, minutes)
}
