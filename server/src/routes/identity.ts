/**
 * Identity routes - the switcher, and nothing more.
 *
 * Shapes:
 *   GET    /api/identity          -> { user, identities }   (who is acting, and who could be)
 *   POST   /api/identity          -> { user, identities }   (act as someone else)
 *   DELETE /api/identity          -> { user, identities }   (back to the default)
 *
 * ===========================================================================
 * THIS IS NOT A LOGIN, AND IT IS NOT NAMED AFTER ONE
 * ===========================================================================
 *
 * There is no password field, no token, no session row and no revocation,
 * because there is nothing to authenticate: see services/identityService.ts for
 * the trade that was made and why. Any caller can name any profile id.
 *
 * The route is called `identity` rather than `auth` precisely so that the shape
 * of the API does not imply a security property that is not there. A reader
 * scanning the route list should not be able to conclude "this application
 * authenticates users" from the path alone.
 *
 * All three responses carry the SAME body. The client's state is "who is acting
 * and who could be", and it is one value - returning a different shape from each
 * verb would force the client to merge three cases for no benefit.
 */
import { Router } from 'express'

import { getConfig } from '../config.ts'
import { badRequest } from '../lib/errors.ts'
import { ROLE_LABELS } from '../lib/roles.ts'
import { identitySwitchSchema, parseOrThrow } from '../lib/validation.ts'
import { currentActor } from '../middleware/identity.ts'
import { asyncHandler } from '../middleware/errorHandler.ts'
import { recordAudit } from '../services/auditService.ts'
import {
  DEFAULT_ACTOR_ID,
  findIdentity,
  IDENTITY_COOKIE_NAME,
  identityCookieOptions,
  listIdentities,
  type AuthenticatedUser,
} from '../services/identityService.ts'

export const identityRouter = Router()

/**
 * The body every verb returns.
 *
 * Written once so the three responses cannot drift apart: the client holds one
 * piece of state - who is acting, and who could be - and a verb that omitted
 * `available` would leave the switcher blank until the page was reloaded.
 */
async function respondWith(
  res: { json: (body: unknown) => unknown },
  current: AuthenticatedUser,
): Promise<void> {
  res.json({
    user: {
      id: current.id,
      email: current.email,
      displayName: current.displayName,
      role: current.role,
      roleLabel: ROLE_LABELS[current.role],
      department: current.department,
    },
    identities: await listIdentities(),
  })
}

identityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    await respondWith(res, currentActor(req))
  }),
)

/**
 * Acts as somebody else.
 *
 * Rejects an id that resolves to nothing rather than silently storing it. A
 * cookie pointing at a missing profile would still WORK - `resolveActor` falls
 * back to the default - but the caller would be told they had switched while the
 * next request acted as somebody else entirely, which is worse than an error.
 */
identityRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(identitySwitchSchema, req.body, badRequest)

    const chosen = await findIdentity(input.userId)

    if (!chosen) {
      throw badRequest('That is not a known identity.', [
        { field: 'userId', message: `No profile exists with id "${input.userId}".` },
      ])
    }

    res.cookie(IDENTITY_COOKIE_NAME, chosen.id, identityCookieOptions(getConfig().isProduction))

    // Recorded because the audit trail is one of the things the role model is
    // FOR, and "who was acting when this happened" is only reconstructable if
    // the moments of switching are in it too. The actor recorded is the identity
    // being adopted, since that is who the next action will belong to; the
    // identity being left is in the metadata.
    await recordAudit({
      actorId: chosen.id,
      action: 'identity.switched',
      entityType: 'profile',
      entityId: chosen.id,
      metadata: {
        previousActorId: req.user?.id ?? null,
        note: 'Identity selection is not authentication; no credential was presented.',
      },
    })

    await respondWith(res, chosen)
  }),
)

/** Returns to the default identity. Never an error: there is no signed-out state. */
identityRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const previous = req.user?.id ?? null

    res.clearCookie(IDENTITY_COOKIE_NAME, { path: '/' })

    const fallback = await findIdentity(DEFAULT_ACTOR_ID)

    if (!fallback) {
      throw new Error(
        `The default identity "${DEFAULT_ACTOR_ID}" is missing from the database. ` +
          'The demo data has not been seeded - run `npm run db:reset`.',
      )
    }

    // Only worth an audit entry when it actually changed something.
    if (previous && previous !== fallback.id) {
      await recordAudit({
        actorId: fallback.id,
        action: 'identity.reset',
        entityType: 'profile',
        entityId: fallback.id,
        metadata: { previousActorId: previous },
      })
    }

    await respondWith(res, fallback)
  }),
)
