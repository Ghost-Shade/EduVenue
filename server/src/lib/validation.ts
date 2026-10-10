/**
 * Request validation schemas.
 *
 * ===========================================================================
 * SERVER-SIDE VALIDATION IS THE ONLY VALIDATION THAT COUNTS
 * ===========================================================================
 *
 * The client validates the same inputs for a better experience, but that is a
 * convenience. Anything reaching these schemas is treated as hostile, because
 * a request can be crafted with curl and never touch the interface at all.
 *
 * These schemas check SHAPE and OBVIOUS range errors. Business rules that
 * depend on the database - does this facility exist, is it active, is the slot
 * free, is the user eligible - are enforced in the service layer, where the
 * data is available. Keeping the two concerns separate means a validation
 * failure and a policy failure produce different, honest error codes.
 */
import { z } from 'zod'

import type { ApiErrorDetail } from './errors.ts'
import { USER_ROLES } from './roles.ts'

/** `YYYY-MM-DD`, the local calendar date format used throughout the API. */
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

/** 24-hour `HH:MM`, the local wall-clock time format used throughout the API. */
const LOCAL_TIME = /^\d{2}:\d{2}$/

const uuidLike = z.string().trim().min(1).max(64)

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  password: z.string().min(1).max(200),
})

export type LoginInput = z.infer<typeof loginSchema>

// ---------------------------------------------------------------------------
// Bookings
//
// The client sends the date and times the user actually picked, as local
// Nairobi wall-clock values. Conversion to UTC happens once, in the booking
// service, so that no route ever has to think about timezones.
// ---------------------------------------------------------------------------

export const bookingCreateSchema = z
  .object({
    facilityId: uuidLike,
    activityPurpose: z.string().trim().min(3).max(120),
    expectedAttendance: z.number().int().positive().max(5000),

    date: z.string().regex(LOCAL_DATE, 'Date must be in YYYY-MM-DD format'),
    startTime: z.string().regex(LOCAL_TIME, 'Start time must be in HH:MM format'),
    endTime: z.string().regex(LOCAL_TIME, 'End time must be in HH:MM format'),
  })
  .refine(
    // Fixed-width HH:MM strings compare correctly as strings, so this needs no
    // date parsing. It is the first of several checks that a booking is not
    // zero-length or inverted; the service repeats it after conversion to
    // catch any timezone-boundary edge case the string form could hide.
    (value) => value.endTime > value.startTime,
    {
      message: 'End time must be later than start time',
      path: ['endTime'],
    },
  )

export type BookingCreateInput = z.infer<typeof bookingCreateSchema>

export const bookingCancelSchema = z.object({
  reason: z.string().trim().max(400).optional(),
})

export type BookingCancelInput = z.infer<typeof bookingCancelSchema>

export const availabilityQuerySchema = z.object({
  date: z.string().regex(LOCAL_DATE, 'Date must be in YYYY-MM-DD format'),
})

// ---------------------------------------------------------------------------
// Facility directory search
//
// Query strings arrive as text, so numeric filters are coerced. `z.coerce`
// turns a bad value into NaN, which `.int()` then rejects - so a client sending
// `?minCapacity=abc` gets a clear validation error rather than a silent
// unfiltered result.
// ---------------------------------------------------------------------------

export const facilityQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  categoryId: uuidLike.optional(),
  building: z.string().trim().max(120).optional(),
  activity: z.string().trim().max(120).optional(),
  minCapacity: z.coerce.number().int().positive().max(5000).optional(),
  status: z.enum(['active', 'inactive', 'maintenance']).optional(),

  // NOT z.coerce.boolean(): that applies Boolean(), and Boolean('false') is
  // true. `?includeInactive=false` would therefore have meant "yes". Query
  // parameters arrive as strings, so the string forms are parsed explicitly.
  includeInactive: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined
      if (typeof value === 'boolean') return value
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
    }),

  sort: z.enum(['name', 'capacity', 'category', 'building']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
})

export type FacilityQueryInput = z.infer<typeof facilityQuerySchema>

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export const recommendationSchema = z
  .object({
    date: z.string().regex(LOCAL_DATE, 'Date must be in YYYY-MM-DD format'),
    startTime: z.string().regex(LOCAL_TIME, 'Start time must be in HH:MM format'),
    endTime: z.string().regex(LOCAL_TIME, 'End time must be in HH:MM format'),

    expectedAttendance: z.number().int().positive().max(5000),
    activityPurpose: z.string().trim().min(3).max(120),

    preferredCategoryId: uuidLike.optional(),
    preferredBuilding: z.string().trim().max(120).optional(),
    requiredEquipment: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  })
  .refine((value) => value.endTime > value.startTime, {
    message: 'End time must be later than start time',
    path: ['endTime'],
  })

export type RecommendationInput = z.infer<typeof recommendationSchema>

// ---------------------------------------------------------------------------
// Facility administration
// ---------------------------------------------------------------------------

const timeOfDay = z.string().regex(LOCAL_TIME, 'Time must be in HH:MM format')

/**
 * The facility field validators, defined ONCE and reused by both the create and
 * update schemas.
 *
 * These deliberately carry NO `.default()` values. Defaults belong only to
 * creation; see the note on `facilityUpdateSchema` below for why that
 * distinction is load-bearing rather than stylistic.
 */
const facilityFields = {
  name: z.string().trim().min(2).max(120),
  categoryId: uuidLike,
  building: z.string().trim().min(1).max(120),
  locationDescription: z.string().trim().max(300),
  capacity: z.number().int().positive().max(5000),
  description: z.string().trim().max(1000),

  equipment: z.array(z.string().trim().min(1).max(80)).max(30),
  accessibility: z.array(z.string().trim().min(1).max(80)).max(30),

  status: z.enum(['active', 'inactive', 'maintenance']),

  opensAt: timeOfDay,
  closesAt: timeOfDay,
  closedDays: z.array(z.number().int().min(0).max(6)).max(7),

  slotMinutes: z.number().int().min(15).max(240),
  bufferMinutes: z.number().int().min(0).max(120),

  bookingPolicy: z.enum(['open', 'restricted', 'supervisor_required']),
  minRole: z.enum(USER_ROLES as unknown as [string, ...string[]]),
  allowedActivities: z.array(z.string().trim().min(1).max(80)).max(30),
} satisfies z.ZodRawShape

export const facilityCreateSchema = z
  .object({
    ...facilityFields,

    // Defaults apply ONLY here. An administrator creating a facility may leave
    // these out and get sensible values.
    locationDescription: facilityFields.locationDescription.default(''),
    description: facilityFields.description.default(''),
    equipment: facilityFields.equipment.default([]),
    accessibility: facilityFields.accessibility.default([]),
    status: facilityFields.status.default('active'),
    opensAt: facilityFields.opensAt.default('08:00'),
    closesAt: facilityFields.closesAt.default('18:00'),
    closedDays: facilityFields.closedDays.default([]),
    slotMinutes: facilityFields.slotMinutes.default(60),
    bufferMinutes: facilityFields.bufferMinutes.default(0),
    bookingPolicy: facilityFields.bookingPolicy.default('open'),
    minRole: facilityFields.minRole.default('rep'),
    allowedActivities: facilityFields.allowedActivities.default([]),
  })
  .refine((value) => value.closesAt > value.opensAt, {
    message: 'Closing time must be later than opening time',
    path: ['closesAt'],
  })
  .refine((value) => value.bufferMinutes < value.slotMinutes, {
    message: 'Transition buffer must be shorter than the booking slot length',
    path: ['bufferMinutes'],
  })

export type FacilityCreateInput = z.infer<typeof facilityCreateSchema>

/**
 * Partial update: every field optional and, crucially, NO defaults.
 *
 * If this schema inherited `.default()` values, a PATCH that changed only the
 * capacity would also silently reset status to 'active', opensAt to '08:00' and
 * bookingPolicy to 'open' - overwriting settings the client never mentioned.
 * A partial update must mean "change only what was sent", so absent fields stay
 * absent and the service layer leaves those columns alone.
 *
 * Consequence: cross-field rules (closing after opening, buffer shorter than
 * slot) cannot be expressed here, because either side may be absent. The
 * facility service re-checks them against the MERGED record before writing, so
 * the rule is still enforced - just one layer down, where both old and new
 * values are visible.
 *
 * Built from `facilityFields` directly rather than via
 * `facilityCreateSchema.innerType()`, which does not work: `create` is a
 * ZodEffects wrapping another ZodEffects (one per `.refine`), and `innerType()`
 * unwraps only a single layer.
 */
export const facilityUpdateSchema = z.object(facilityFields).partial()

export type FacilityUpdateInput = z.infer<typeof facilityUpdateSchema>

export const blockCreateSchema = z
  .object({
    date: z.string().regex(LOCAL_DATE, 'Date must be in YYYY-MM-DD format'),
    startTime: timeOfDay,
    endTime: timeOfDay,
    reason: z.string().trim().min(3).max(200),
  })
  .refine((value) => value.endTime > value.startTime, {
    message: 'End time must be later than start time',
    path: ['endTime'],
  })

export type BlockCreateInput = z.infer<typeof blockCreateSchema>

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Converts a ZodError into the flat list of field-level messages the client
 * renders next to the offending inputs.
 */
export function toErrorDetails(error: z.ZodError): ApiErrorDetail[] {
  return error.errors.map((issue) => ({
    field: issue.path.join('.') || undefined,
    message: issue.message,
  }))
}

/**
 * Parses with a schema and throws the caller's error type on failure.
 *
 * Services use this so that a validation failure is raised in the same shape as
 * every other API failure, rather than leaking a ZodError to the error handler.
 */
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  onError: (message: string, details: ApiErrorDetail[]) => Error,
): T {
  const result = schema.safeParse(value)

  if (!result.success) {
    const details = toErrorDetails(result.error)
    // Surface the first message in the headline, so a client that only shows
    // one line still shows something specific.
    const headline = details[0]?.message ?? 'The request was not valid.'
    throw onError(headline, details)
  }

  return result.data
}
