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
 * THE DIRECTORY IS PUBLIC TO SIGNED-IN USERS ONLY. Browsing facilities is the
 * one thing a plain student may do, but it is still behind `requireAuth`: the
 * brief's role model has no anonymous audience, and an unauthenticated directory
 * would be a free inventory of university buildings on a public host.
 *
 * ROUTE ORDER MATTERS. `/categories`, `/buildings` and `/activities` are
 * declared BEFORE `/:id`, otherwise Express would match `/categories` as a
 * facility id and return 404 for it.
 */
import { Router } from 'express'

import { badRequest } from '../lib/errors.ts'
import { availabilityQuerySchema, facilityQuerySchema, parseOrThrow } from '../lib/validation.ts'
import { currentUser, requireAuth } from '../middleware/auth.ts'
import { asyncHandler } from '../middleware/errorHandler.ts'
import { getAvailability, listActivities, listBuildings, listCategories, getFacilityOrThrow, listFacilities } from '../services/facilityService.ts'

export const facilitiesRouter = Router()

// Everything in this router requires a session.
facilitiesRouter.use(requireAuth)

facilitiesRouter.get(
  '/',
  asyncHandler((req, res) => {
    const query = parseOrThrow(facilityQuerySchema, req.query, badRequest)

    // `includeInactive` is an administrative view of withdrawn and
    // maintenance facilities. A non-administrator asking for it is not
    // attacking anything - it is directory metadata, not a secret - but
    // honouring it would show them rooms they cannot book, which is the exact
    // confusion facilityService.ts is written to avoid. So it is ignored
    // rather than refused, and the effective filters are echoed back so the
    // client can see what was actually applied.
    const isAdmin = currentUser(req).role === 'admin'
    const includeInactive = isAdmin && query.includeInactive === true

    const facilities = listFacilities({
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

facilitiesRouter.get('/categories', (_req, res) => {
  res.json({ categories: listCategories() })
})

facilitiesRouter.get('/buildings', (_req, res) => {
  res.json({ buildings: listBuildings() })
})

facilitiesRouter.get('/activities', (_req, res) => {
  res.json({ activities: listActivities() })
})

facilitiesRouter.get(
  '/:id/availability',
  asyncHandler((req, res) => {
    const query = parseOrThrow(availabilityQuerySchema, req.query, badRequest)

    // A facility id that does not exist produces a 404 from the service, so an
    // unknown id and an unknown path are distinguishable by the client.
    res.json({ availability: getAvailability(req.params.id, query.date) })
  }),
)

facilitiesRouter.get(
  '/:id',
  asyncHandler((req, res) => {
    res.json({ facility: getFacilityOrThrow(req.params.id) })
  }),
)
