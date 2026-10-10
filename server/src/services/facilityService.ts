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
 *
 * ===========================================================================
 * TWO POSTGRES BEHAVIOUR CHANGES THAT WOULD HAVE FAILED SILENTLY
 * ===========================================================================
 *
 * Neither of these throws. Both simply return the wrong answer, which is why
 * they are called out here rather than left to be discovered:
 *
 *   - SQLite's `like` is case-insensitive for ASCII; Postgres's is NOT. A
 *     straight port of the directory search would leave "laboratory" no longer
 *     matching "Computing Laboratory" - a search box that quietly stops working
 *     for lowercase input, which is how most people type. Every search
 *     comparison here is therefore `ilike`.
 *
 *   - `json_each` is SQLite-only. The activity filter now uses jsonb
 *     containment (`@>`), which is exact array membership. Substring matching
 *     on the raw JSON text would have made a search for "Revision" also match
 *     "Revision session", so the containment form is the one that preserves the
 *     original intent.
 */
import { asInstantIso, db, type Queryable } from '../db/connection.ts'
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

/**
 * A row as the driver returns it.
 *
 * The jsonb columns arrive as parsed JavaScript values, not strings - `pg`
 * decodes jsonb on the way out. The `unknown` type is deliberate: the driver
 * guarantees the value is JSON, not that it is an array of strings, so the shape
 * check below is still doing real work.
 */
interface RawFacilityRow {
  id: string
  name: string
  category_id: string
  category_name: string
  building: string
  location_description: string
  capacity: number
  description: string
  equipment: unknown
  accessibility: unknown
  status: string
  opens_at: string
  closes_at: string
  closed_days: unknown
  slot_minutes: number
  buffer_minutes: number
  booking_policy: string
  min_role: string
  allowed_activities: unknown
  created_at: Date
  updated_at: Date
}

/**
 * Narrows a jsonb column to a string array.
 *
 * jsonb is guaranteed to be valid JSON but not to be an array of strings, so a
 * malformed row is still possible - and degrading to an empty list is better
 * than throwing, because one odd row should not take down the whole directory.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** Narrows a jsonb column to an array of weekday numbers, discarding anything out of range. */
function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is number =>
      typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 6,
  )
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
    equipment: toStringArray(row.equipment),
    accessibility: toStringArray(row.accessibility),
    status: row.status as FacilityStatus,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    closedDays: toNumberArray(row.closed_days),
    slotMinutes: row.slot_minutes,
    bufferMinutes: row.buffer_minutes,
    bookingPolicy: row.booking_policy as BookingPolicy,
    minRole: row.min_role,
    allowedActivities: toStringArray(row.allowed_activities),
    createdAt: asInstantIso(row.created_at),
    updatedAt: asInstantIso(row.updated_at),
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
export async function listFacilities(
  filters: FacilityFilters = {},
  q: Queryable = db,
): Promise<FacilityRecord[]> {
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
    // Escape the ILIKE wildcards so a search for "50%" is a literal search
    // rather than a pattern that matches everything. The escape character must
    // be named explicitly: Postgres, unlike SQLite, does not default to
    // backslash outside of standard_conforming_strings ambiguity.
    const escaped = filters.q.replace(/[\\%_]/g, '\\$&')
    conditions.push(
      `(f.name ilike @q escape '\\' or f.building ilike @q escape '\\' ` +
        `or f.description ilike @q escape '\\' or c.name ilike @q escape '\\')`,
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
    // jsonb containment is exact array membership, which is what json_each
    // gave us in SQLite: "Revision" matches the activity "Revision" and not the
    // activity "Revision session". `@>` survives the named-parameter compiler
    // because its `@` is followed by `>`, which cannot start an identifier.
    conditions.push('f.allowed_activities @> to_jsonb(@activity::text)')
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

  const rows = await q.query<RawFacilityRow>(
    `${SELECT_FACILITY} ${where} order by ${sortColumn} ${direction}, f.name asc`,
    params,
  )

  return rows.map(mapFacility)
}

/**
 * Loads one facility, or throws a 404.
 *
 * Takes an optional query interface so the booking transaction can read the
 * facility on its own connection. It matters there: the facility's buffer and
 * policy are read in the same transaction that writes the booking, so the values
 * enforced and the values stored cannot come from different snapshots.
 */
export async function getFacilityOrThrow(
  facilityId: string,
  q: Queryable = db,
): Promise<FacilityRecord> {
  const row = await q.queryOne<RawFacilityRow>(`${SELECT_FACILITY} where f.id = @facilityId`, {
    facilityId,
  })

  if (!row) {
    throw notFoundFacility()
  }

  return mapFacility(row)
}

/** Loads one facility, or null. Used where a missing record is not an error. */
export async function findFacility(
  facilityId: string,
  q: Queryable = db,
): Promise<FacilityRecord | null> {
  const row = await q.queryOne<RawFacilityRow>(`${SELECT_FACILITY} where f.id = @facilityId`, {
    facilityId,
  })

  return row ? mapFacility(row) : null
}

/** All categories, with a count of active facilities in each. */
export async function listCategories(q: Queryable = db): Promise<CategoryRecord[]> {
  const rows = await q.query<{
    id: string
    name: string
    description: string
    sort_order: number
    facility_count: number
  }>(
    // `count(*)` is bigint, which `pg` returns as a STRING rather than a number.
    // Casting in SQL keeps the JSON response a number, as it was under SQLite.
    `select c.id, c.name, c.description, c.sort_order,
            (select count(*)::int from facilities f
              where f.category_id = c.id and f.status = 'active') as facility_count
       from facility_categories c
      order by c.sort_order asc, c.name asc`,
  )

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    facilityCount: row.facility_count,
  }))
}

/** Distinct buildings, for the directory's building filter. */
export async function listBuildings(q: Queryable = db): Promise<string[]> {
  const rows = await q.query<{ building: string }>(
    `select distinct building from facilities
      where status = 'active'
      order by building asc`,
  )

  return rows.map((row) => row.building)
}

/** Distinct activity purposes across all active facilities. */
export async function listActivities(q: Queryable = db): Promise<string[]> {
  const rows = await q.query<{ activity: string }>(
    // jsonb_array_elements_text is the Postgres equivalent of json_each for
    // reading a JSON array as one row per element. `distinct` then collapses
    // the same activity offered by several facilities into a single filter
    // option, which is what the dropdown needs.
    `select distinct a.activity
       from facilities f, jsonb_array_elements_text(f.allowed_activities) as a(activity)
      where f.status = 'active'
      order by a.activity asc`,
  )

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
export async function getAvailability(
  facilityId: string,
  date: LocalDateString,
  q: Queryable = db,
): Promise<AvailabilityResult> {
  const facility = await getFacilityOrThrow(facilityId, q)

  // Weekday is derived from the local date, not from a UTC instant, so a
  // Sunday closure is evaluated in the campus timezone.
  const middayUtc = combineLocalDateTimeToUtc(date, '12:00')
  const weekday = new Date(middayUtc.getTime() + 12 * 60 * 60 * 1000).getUTCDay()

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

  const busyRows = await q.query<{
    id: string
    kind: string
    activity_purpose: string
    expected_attendance: number | null
    start_time: Date
    end_time: Date
  }>(
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
    { facilityId, windowStart, windowEnd },
  )

  const busy: BusyPeriod[] = busyRows.map((row) => ({
    id: row.id,
    kind: row.kind === 'block' ? 'block' : 'booking',
    activityPurpose: row.activity_purpose,
    expectedAttendance: row.expected_attendance,
    startTime: asInstantIso(row.start_time),
    endTime: asInstantIso(row.end_time),
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
