/**
 * API route aggregation.
 *
 * Every route is mounted under `/api` by app.ts. Keeping the mounting in one
 * place makes the full surface of the API readable at a glance, which matters
 * when checking that a new route was not accidentally left open.
 *
 * Note what is NOT here: there is no `auth` router. Authentication was removed
 * rather than disabled - see services/identityService.ts - so the only thing
 * this API knows about a caller is which profile they have adopted, via
 * `/identity`.
 */
import { Router } from 'express'

import { bookingsRouter } from './bookings.ts'
import { facilitiesRouter } from './facilities.ts'
import { identityRouter } from './identity.ts'

export function createApiRouter(): Router {
  const router = Router()

  router.use('/identity', identityRouter)
  router.use('/facilities', facilitiesRouter)
  router.use('/bookings', bookingsRouter)

  // Route groups added in later milestones:
  //   router.use('/admin', adminRouter)

  return router
}
