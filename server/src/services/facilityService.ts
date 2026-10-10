/**
 * Facility directory and availability.
 *
 * Two things are enforced here rather than in the interface:
 *
 *  1. INACTIVE AND MAINTENANCE FACILITIES ARE EXCLUDED BY DEFAULT. Showing a
 *     withdrawn room in the directory and then rejecting the booking is a worse
 *     experience than not offering it, and an inactive facility must never be
 *     bookable. Administrators opt in explicitly with `includeInactive`.
 *
 *  2. AVAILABILITY IS DESCRIBED HONESTLY. The free slots returned mean "no
 *     confirmed booking or block is recorded for this time". They do NOT mean
 *     the room is physically unoccupied. That distinction is carried through to
 *     the interface, because the alternative is the application asserting
 *     something it cannot know.
 */
import { getDb } from '../db/connection.ts'
import { notFoundFacility } from '../lib/errors.ts'
import { subtractIntervals, type Interval } from '../lib/overlap.ts'
import { combineLocalDateTimeToUtc, type LocalDateString, type LocalTimeString } from '../lib/time.ts'

export type FacilityStatus = 'active' | 'inactive' | 'maintenance'
export type BookingPolicy = 'open' | 'restricted' | 'supervisor_required'

export interface FacilityRecord {
  id: string
  name: string
  categoryId: string
  categoryName: string
  building: string
  locationDescription: string
  capacity: number
  description: string
  equipment: string[]
  accessibility: string[]
  status: FacilityStatus
  opensAt: LocalTimeString
  closesAt: LocalTimeString
  closedDays: number[]
  slotMinutes: number
  bufferMinutes: number
  bookingPolicy: BookingPolicy
  minRole: string
  allowedActivities: string[]
  createdAt: string
  updatedAt: string
}

export interface CategoryRecord {
  id: string
  name: string
  description: string
  sortOrder: number
  facilityCount: number
}

export interface FacilityFilters {
  q?: string | undefined
  categoryId?: string | undefined
  building?: string | undefined
  activity?: string | undefined
  minCapacity?: number | undefined
  status?: FacilityStatus | undefined
  includeInactive?: boolean | undefined
  sort?: 'name' | 'capacity' | 'category' | 'building' | undefined
  direction?: 'asc' | 'desc' | undefined
}

interface RawFacilityRow {
  id: string
  name: string
  category_id: string
  category_name: string
  building: string
  location_description: string
  capacity: number
  description: string
  equipment: string
  accessibility: string
  status: string
  opens_at: string
  closes_at: string
  closed_days: string
  slot_minutes: number
  buffer_minutes: number
  booking_policy: string
  min_role: string
  allowed_activities: string
  created_at: string
  updated_at: string
}

/**
 * Parses a JSON array column into a string array.
 *
 * The schema has `check (json_valid(...))` on every JSON column, so malformed
 * JSON cannot be stored. This still defends against a value that is valid JSON
 * but not an array of strings, and degrades to an empty list rather than
 * throwing - a single odd row should not take down the whole directory.
 */
function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** Parses a JSON array of weekday numbers, discarding anything out of range. */
function parseNumberArray(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 6,
    )
  } catch {
    return []
  }
}

function mapFacility(row: RawFacilityRow): FacilityRecord {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    building: row.building,
    locationDescription: row.location_description,
    capacity: row.capacity,
    description: row.description,
    equipment: parseStringArray(row.equipment),
    accessibility: parseStringArray(row.accessibility),
    status: row.status as FacilityStatus,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    closedDays: parseNumberArray(row.closed_days),
    slotMinutes: row.slot_minutes,
    bufferMinutes: row.buffer_minutes,
    bookingPolicy: row.booking_policy as BookingPolicy,
    minRole: row.min_role,
    allowedActivities: parseStringArray(row.allowed_activities),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FACILITY = `
  select f.id, f.name, f.category_id, c.name as category_name, f.building,
         f.location_description, f.capacity, f.description, f.equipment,
         f.accessibility, f.status, f.opens_at, f.closes_at, f.closed_days,
         f.slot_minutes, f.buffer_minutes, f.booking_policy, f.min_role,
         f.allowed_activities, f.created_at, f.updated_at
    from facilities f
    join facility_categories c on c.id = f.category_id
`

/**
 * Lists facilities matching the given filters.
 *
 * The WHERE clause is assembled from a fixed set of fragments, each added only
 * when its filter is present, and every value is bound as a parameter. No user
 * input is ever concatenated into the SQL string.
 */
export function listFacilities(filters: FacilityFilters = {}): FacilityRecord[] {
  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  if (!filters.includeInactive) {
    // The default directory shows only what can actually be booked.
    conditions.push(`f.status = 'active'`)
  } else if (filters.status) {
    conditions.push('f.status = @status')
    params['status'] = filters.status
  }

  if (filters.q) {
    // Escape the LIKE wildcards so a search for "50%" is a literal search
    // rather than a pattern that matches everything.
    const escaped = filters.q.replace(/[\\%_]/g, '\\$&')
    conditions.push(
      `(f.name like @q escape '\\' or f.building like @q escape '\\' ` +
        `or f.description like @q escape '\\' or c.name like @q escape '\\')`,
    )
    params['q'] = `%${escaped}%`
  }

  if (filters.categoryId) {
    conditions.push('f.category_id = @categoryId')
    params['categoryId'] = filters.categoryId
  }

  if (filters.building) {
    conditions.push('f.building = @building')
    params['building'] = filters.building
  }

  if (filters.minCapacity !== undefined) {
    conditions.push('f.capacity >= @minCapacity')
    params['minCapacity'] = filters.minCapacity
  }

  if (filters.activity) {
    // JSON array membership. json_each expands the array so the comparison is
    // exact rather than a substring match on the raw JSON text - otherwise
    // searching for "Revision" would also match "Revision session".
    conditions.push(
      `exists (select 1 from json_each(f.allowed_activities) a where a.value = @activity)`,
    )
    params['activity'] = filters.activity
  }

  const sortColumn =
    filters.sort === 'capacity'
      ? 'f.capacity'
      : filters.sort === 'category'
        ? 'c.sort_order'
        : filters.sort === 'building'
          ? 'f.building'
          : 'f.name'

  const direction = filters.direction === 'desc' ? 'desc' : 'asc'

  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''

  const rows = getDb()
    .prepare(
      `${SELECT_FACILITY} ${where} order by ${sortColumn} ${direction}, f.name asc`,
    )
    .all(params) as RawFacilityRow[]

  return rows.map(mapFacility)
}

/** Loads one facility, or throws a 404. */
export function getFacilityOrThrow(facilityId: string): FacilityRecord {
  const row = getDb()
    .prepare(`${SELECT_FACILITY} where f.id = ?`)
    .get(facilityId) as RawFacilityRow | undefined

  if (!row) {
    throw notFoundFacility()
  }

  return mapFacility(row)
}

/** Loads one facility, or null. Used where a missing record is not an error. */
export function findFacility(facilityId: string): FacilityRecord | null {
  const row = getDb()
    .prepare(`${SELECT_FACILITY} where f.id = ?`)
    .get(facilityId) as RawFacilityRow | undefined

  return row ? mapFacility(row) : null
}

/** All categories, with a count of active facilities in each. */
export function listCategories(): CategoryRecord[] {
  const rows = getDb()
    .prepare(
      `select c.id, c.name, c.description, c.sort_order,
              (select count(*) from facilities f
                where f.category_id = c.id and f.status = 'active') as facility_count
         from facility_categories c
        order by c.sort_order asc, c.name asc`,
    )
    .all() as Array<{
    id: string
    name: string
    description: string
    sort_order: number
    facility_count: number
  }>

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    facilityCount: row.facility_count,
  }))
}

/** Distinct buildings, for the directory's building filter. */
export function listBuildings(): string[] {
  const rows = getDb()
    .prepare(
      `select distinct building from facilities
        where status = 'active'
        order by building asc`,
    )
    .all() as Array<{ building: string }>

  return rows.map((row) => row.building)
}

/** Distinct activity purposes across all active facilities. */
export function listActivities(): string[] {
  const rows = getDb()
    .prepare(
      `select distinct a.value as activity
         from facilities f, json_each(f.allowed_activities) a
        where f.status = 'active'
        order by a.value asc`,
    )
    .all() as Array<{ activity: string }>

  return rows.map((row) => row.activity)
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * A booking occupying part of a facility's day.
 *
 * Note what is ABSENT: the identity of the person who booked. Anyone can see
 * that a room is taken and what it is taken for, which is what scheduling
 * needs. Who booked it is not required for that, and the brief asks us not to
 * collect or expose personal information beyond what the purpose needs.
 */
export interface BusyPeriod {
  id: string
  kind: 'booking' | 'block'
  activityPurpose: string
  expectedAttendance: number | null
  startTime: string
  endTime: string
}

export interface AvailabilityResult {
  facility: FacilityRecord
  date: LocalDateString
  /** Local wall-clock operating window for this date. Empty when closed. */
  window: { opensAt: LocalTimeString; closesAt: LocalTimeString } | null
  /** Set when the facility does not operate on this date. */
  closedReason: string | null
  busy: BusyPeriod[]
  /** Intervals with no recorded booking or block. NOT a claim of physical vacancy. */
  freeSlots: Array<{ startTime: string; endTime: string; minutes: number }>
  /** True for a date in the past, where availability is historical only. */
  isPast: boolean
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Builds the availability picture for one facility on one local date.
 *
 * The window is the facility's operating hours ON THAT DATE, not the whole
 * calendar day - a room that opens at 08:00 is not "free" at 06:00, it is
 * simply not operating.
 */
export function getAvailability(facilityId: string, date: LocalDateString): AvailabilityResult {
  const facility = getFacilityOrThrow(facilityId)

  // Weekday is derived from the local date, not from a UTC instant, so a
  // Sunday closure is evaluated in the campus timezone.
  const middayUtc = combineLocalDateTimeToUtc(date, '12:00')
  const weekday = new Date(
    middayUtc.getTime() + 12 * 60 * 60 * 1000,
  ).getUTCDay()

  const nowMs = Date.now()
  const isPast = combineLocalDateTimeToUtc(date, '23:59').getTime() < nowMs

  if (facility.status !== 'active') {
    return {
      facility,
      date,
      window: null,
      closedReason:
        facility.status === 'inactive'
          ? 'This facility has been withdrawn from booking.'
          : 'This facility is marked as under maintenance.',
      busy: [],
      freeSlots: [],
      isPast,
    }
  }

  if (facility.closedDays.includes(weekday)) {
    return {
      facility,
      date,
      window: null,
      closedReason: `This facility does not operate on ${DAY_NAMES[weekday]}s.`,
      busy: [],
      freeSlots: [],
      isPast,
    }
  }

  const windowStart = combineLocalDateTimeToUtc(date, facility.opensAt)
  const windowEnd = combineLocalDateTimeToUtc(date, facility.closesAt)
  const window: Interval = { start: windowStart, end: windowEnd }

  const busyRows = getDb()
    .prepare(
      `select b.id, 'booking' as kind, b.activity_purpose, b.expected_attendance,
              b.start_time, b.end_time
         from bookings b
        where b.facility_id = @facilityId
          and b.status = 'confirmed'
          and b.start_time < @windowEnd
          and b.end_time > @windowStart

        union all

       select k.id, 'block' as kind, k.reason as activity_purpose, null as expected_attendance,
              k.start_time, k.end_time
         from facility_blocks k
        where k.facility_id = @facilityId
          and k.start_time < @windowEnd
          and k.end_time > @windowStart

        order by start_time asc`,
    )
    .all({
      facilityId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    }) as Array<{
    id: string
    kind: string
    activity_purpose: string
    expected_attendance: number | null
    start_time: string
    end_time: string
  }>

  const busy: BusyPeriod[] = busyRows.map((row) => ({
    id: row.id,
    kind: row.kind === 'block' ? 'block' : 'booking',
    activityPurpose: row.activity_purpose,
    expectedAttendance: row.expected_attendance,
    startTime: row.start_time,
    endTime: row.end_time,
  }))

  const free = subtractIntervals(
    window,
    busy.map((period) => ({ start: new Date(period.startTime), end: new Date(period.endTime) })),
  )

  return {
    facility,
    date,
    window: { opensAt: facility.opensAt, closesAt: facility.closesAt },
    closedReason: null,
    busy,
    freeSlots: free.map((slot) => ({
      startTime: slot.start.toISOString(),
      endTime: slot.end.toISOString(),
      minutes: Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000),
    })),
    isPast,
  }
}
