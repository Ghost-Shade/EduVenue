/**
 * Booking routes.
 *
 * Shapes:
 *   POST /api/bookings                   -> 201 { booking }
 *   POST /api/bookings/recommendations   -> { result }
 *   GET  /api/bookings/mine?scope=       -> { bookings }
 *   GET  /api/bookings/:id               -> { booking }
 *   POST /api/bookings/:id/cancel        -> { booking }
 *
 * ===========================================================================
 * WHY BOOKING IS GATED ON THE 'rep' ROLE HERE, AND NOT ONLY PER FACILITY
 * ===========================================================================
 *
 * The rule "students may browse but not book" could have been left entirely to
 * each facility's `min_role`. It is not, because a single facility misconfigured
 * with `min_role = 'student'` would then silently open booking to the whole
 * student body, with nothing else in the system objecting. This guard makes the
 * role model true at the route level as well, so the misconfiguration degrades
 * to "still not bookable by a student" instead of a permission hole.
 *
 * Facilities may still be MORE restrictive than 'rep' (a medical lab requires a
 * supervisor); that is enforced per facility, in the booking service.
 *
 * ===========================================================================
 * NO APPROVAL STEP
 * ===========================================================================
 *
 * A booking that satisfies every rule is CONFIRMED immediately by this route.
 * There is no pending state and no administrator queue, because the brief's
 * central requirement is that eligible representatives get an instant
 * confirmation. The controls that would otherwise be provided by an approval
 * step are provided instead by the machine-checkable rules - role, policy,
 * activity, capacity, operating hours, blocks and non-overlap - all evaluated
 * inside the booking transaction.
 */
import { Router } from 'express'

import { badRequest, notFound } from '../lib/errors.ts'
import {
  bookingCancelSchema,
  bookingCreateSchema,
  parseOrThrow,
  recommendationSchema,
} from '../lib/validation.ts'
import { currentActor, requireMinRole } from '../middleware/identity.ts'
import { asyncHandler } from '../middleware/errorHandler.ts'
import { getBookingOrThrow, createBooking, cancelBooking, listBookingsForUser, type BookingScope } from '../services/bookingService.ts'
import { recommendFacilities } from '../services/recommendationService.ts'

export const bookingsRouter = Router()

const SCOPES: BookingScope[] = ['upcoming', 'past', 'all']

/**
 * Recommendations are available to any signed-in user, including a student.
 *
 * That is deliberate: a student can legitimately see which rooms would suit a
 * session, which is useful even though they cannot confirm the booking
 * themselves. The engine applies the same role rules as the booking path, so a
 * student's results come back with the true reason each facility is out of
 * their reach rather than a misleading "no rooms available".
 */
bookingsRouter.post(
  '/recommendations',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(recommendationSchema, req.body, badRequest)

    const result = await recommendFacilities(currentActor(req), {
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      expectedAttendance: input.expectedAttendance,
      activityPurpose: input.activityPurpose,
      preferredCategoryId: input.preferredCategoryId,
      preferredBuilding: input.preferredBuilding,
      requiredEquipment: input.requiredEquipment,
    })

    res.json({ result })
  }),
)

bookingsRouter.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const raw = req.query.scope
    const scope = typeof raw === 'string' ? raw : 'upcoming'

    if (!SCOPES.includes(scope as BookingScope)) {
      throw badRequest(`scope must be one of: ${SCOPES.join(', ')}`, [
        { field: 'scope', message: `Unrecognised scope "${scope}"` },
      ])
    }

    const bookings = await listBookingsForUser(currentActor(req).id, scope as BookingScope)

    res.json({ bookings, scope, count: bookings.length })
  }),
)

bookingsRouter.post(
  '/',
  requireMinRole('rep'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(bookingCreateSchema, req.body, badRequest)

    // Every rule is enforced inside this call, inside one transaction. A
    // rejection leaves no partial booking behind.
    const booking = await createBooking(currentActor(req), input)

    res.status(201).json({ booking })
  }),
)

bookingsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const booking = await getBookingOrThrow(req.params.id)
    const actor = currentActor(req)

    // Someone else's booking is reported as NOT FOUND rather than forbidden, so
    // that the response does not confirm the existence of another person's
    // booking to a caller who guessed an id.
    if (booking.bookedById !== actor.id && actor.role !== 'admin') {
      throw notFound('That booking does not exist.')
    }

    res.json({ booking })
  }),
)

bookingsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(bookingCancelSchema, req.body ?? {}, badRequest)

    const booking = await cancelBooking(currentActor(req), req.params.id, input)

    res.json({ booking })
  }),
)
