/**
 * Facility directory routes.
 *
 * Shapes:
 *   GET /api/facilities                    -> { facilities, count, filters }
 *   GET /api/facilities/categories         -> { categories }
 *   GET /api/facilities/buildings          -> { buildings }
 *   GET /api/facilities/activities         -> { activities }
 *   GET /api/facilities/:id                -> { facility }
 *   GET /api/facilities/:id/availability   -> { availability }
 *
 * THE DIRECTORY IS OPEN TO EVERYONE. There is no role gate on browsing: every
 * request arrives with an identity attached (the caller's chosen one, or the
 * default), and looking at the directory is something every role may do. What is
 * still enforced server-side is BOOKING, per facility, in the booking service.
 *
 * ROUTE ORDER MATTERS. `/categories`, `/buildings` and `/activities` are
 * declared BEFORE `/:id`, otherwise Express would match `/categories` as a
 * facility id and return 404 for it.
 */
import { Router } from 'express'

import { badRequest } from '../lib/errors.ts'
import { availabilityQuerySchema, facilityQuerySchema, parseOrThrow } from '../lib/validation.ts'
import { currentActor } from '../middleware/identity.ts'
import { asyncHandler } from '../middleware/errorHandler.ts'
import { getAvailability, listActivities, listBuildings, listCategories, getFacilityOrThrow, listFacilities } from '../services/facilityService.ts'

export const facilitiesRouter = Router()

facilitiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(facilityQuerySchema, req.query, badRequest)

    // `includeInactive` is an administrative view of withdrawn and
    // maintenance facilities. A non-administrator asking for it is not
    // attacking anything - it is directory metadata, not a secret - but
    // honouring it would show them rooms they cannot book, which is the exact
    // confusion facilityService.ts is written to avoid. So it is ignored
    // rather than refused, and the effective filters are echoed back so the
    // client can see what was actually applied.
    const isAdmin = currentActor(req).role === 'admin'
    const includeInactive = isAdmin && query.includeInactive === true

    const facilities = await listFacilities({
      q: query.q,
      categoryId: query.categoryId,
      building: query.building,
      activity: query.activity,
      minCapacity: query.minCapacity,
      status: query.status,
      includeInactive,
      sort: query.sort,
      direction: query.direction,
    })

    res.json({
      facilities,
      count: facilities.length,
      filters: {
        q: query.q ?? null,
        categoryId: query.categoryId ?? null,
        building: query.building ?? null,
        activity: query.activity ?? null,
        minCapacity: query.minCapacity ?? null,
        status: query.status ?? null,
        includeInactive,
        sort: query.sort ?? 'name',
        direction: query.direction ?? 'asc',
      },
    })
  }),
)

facilitiesRouter.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    res.json({ categories: await listCategories() })
  }),
)

facilitiesRouter.get(
  '/buildings',
  asyncHandler(async (_req, res) => {
    res.json({ buildings: await listBuildings() })
  }),
)

facilitiesRouter.get(
  '/activities',
  asyncHandler(async (_req, res) => {
    res.json({ activities: await listActivities() })
  }),
)

facilitiesRouter.get(
  '/:id/availability',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(availabilityQuerySchema, req.query, badRequest)

    // A facility id that does not exist produces a 404 from the service, so an
    // unknown id and an unknown path are distinguishable by the client.
    res.json({ availability: await getAvailability(req.params.id, query.date) })
  }),
)

facilitiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ facility: await getFacilityOrThrow(req.params.id) })
  }),
)
