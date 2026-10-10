/**
 * API route aggregation.
 *
 * Every route is mounted under `/api` by index.ts. Keeping the mounting in one
 * place makes the full surface of the API readable at a glance, which matters
 * when checking that a new route was not accidentally left public.
 */
import { Router } from 'express'

import { authRouter } from './auth.ts'
import { bookingsRouter } from './bookings.ts'
import { facilitiesRouter } from './facilities.ts'

export function createApiRouter(): Router {
  const router = Router()

  router.use('/auth', authRouter)
  router.use('/facilities', facilitiesRouter)
  router.use('/bookings', bookingsRouter)

  // Route groups added in later milestones:
  //   router.use('/admin', adminRouter)

  return router
}
