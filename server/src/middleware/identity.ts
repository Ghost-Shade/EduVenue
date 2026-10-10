/**
 * Who is acting, and what that role may do.
 *
 * ===========================================================================
 * THERE IS NO AUTHENTICATION HERE, AND THERE IS NO PRETENCE OF ANY
 * ===========================================================================
 *
 * `attachActor` reads a cookie holding a profile id and believes it. It does not
 * verify a signature, because there is nothing signed; it does not check a
 * password, because there are no passwords. See services/identityService.ts for
 * why, and for what was traded away.
 *
 * What is left is still worth having, and is not decorative:
 *
 *   - `attachActor` ALWAYS sets `req.user`. There is no signed-out state, so no
 *     route can accidentally serve a request with no actor and, say, write a
 *     booking with a null `booked_by`.
 *   - The role guards below are genuine AUTHORIZATION. A student is refused a
 *     booking by the server, whatever the interface shows, and a facility whose
 *     `min_role` is 'supervisor' is refused to a representative. That was always
 *     enforced server-side and still is.
 *
 * So the honesty of this file is narrow and worth being precise about: the ROLE
 * rules are real and enforced; the CLAIM that the caller really is Brian is not
 * made and never was, once the password was removed.
 *
 * ===========================================================================
 * WHY A FORGOTTEN GUARD IS STILL VISIBLE
 * ===========================================================================
 *
 * The role guards are opt-in per route. `requireMinRole('rep')` in front of
 * booking is what stops a student, and a new privileged route without one would
 * be open to every role - a hole that is silent in production and only obvious
 * in review. That is unchanged, and is exactly why the guards are declared on
 * the ROUTER (`router.use(...)`) wherever the whole group shares a rule, rather
 * than repeated on each handler.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { forbidden } from '../lib/errors.ts'
import { roleAtLeast, type UserRole } from '../lib/roles.ts'
import {
  IDENTITY_COOKIE_NAME,
  resolveActor,
  type AuthenticatedUser,
} from '../services/identityService.ts'

/**
 * Attaches the acting identity to every request. Never rejects for lack of one.
 *
 * The absent-cookie case is not an error any more: `resolveActor` falls back to
 * the default identity, so the application is never in a state it cannot serve.
 * That is the whole point of the design change - there is no sign-in step to be
 * missing.
 *
 * IT DOES reject when the lookup itself fails, via `next(error)`. Resolving an
 * actor is a database round trip, and the tempting shortcut - catch everything
 * and use the default - would turn a database blip into "everyone silently
 * became Brian", with the audit trail attributing their actions to the wrong
 * person and nothing anywhere saying so. A 500 is the honest answer: the routes
 * this middleware fronts cannot be served without the database anyway.
 */
export async function attachActor(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const cookies = req.cookies as Record<string, unknown> | undefined
  const cookieValue = cookies?.[IDENTITY_COOKIE_NAME]

  try {
    req.user = await resolveActor(typeof cookieValue === 'string' ? cookieValue : undefined)
  } catch (error) {
    next(error)
    return
  }

  next()
}

/**
 * Rejects the request unless the user's role is one of `allowed`.
 *
 * Used where the allowed set is explicit rather than a ranking - for example
 * 'supervisor or admin' when a representative must not qualify.
 */
export function requireRole(...allowed: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = requireActorAttached(req, next)
    if (!user) return

    if (!allowed.includes(user.role)) {
      next(
        forbidden(
          `This action requires the ${allowed.join(' or ')} role. ` +
            `You are acting as a ${user.role}.`,
        ),
      )
      return
    }

    next()
  }
}

/**
 * Rejects the request unless the user's role ranks at least as high as
 * `minimum`. Use this for the common case of "this or anything more
 * privileged".
 */
export function requireMinRole(minimum: UserRole): RequestHandler {
  return (req, _res, next) => {
    const user = requireActorAttached(req, next)
    if (!user) return

    if (!roleAtLeast(user.role, minimum)) {
      next(
        forbidden(
          `This action requires at least the ${minimum} role. ` +
            `You are acting as a ${user.role}.`,
        ),
      )
      return
    }

    next()
  }
}

/**
 * The acting user, or a thrown error.
 *
 * Exists so that route handlers can obtain a non-optional user without a
 * non-null assertion at every call site, which would hide a genuine mistake if a
 * route were ever declared without an actor attached - the mistake being a
 * booking written with `booked_by = null`.
 */
export function currentActor(req: Request): AuthenticatedUser {
  if (!req.user) {
    // Only reachable if a router carrying these guards were mounted on an
    // application that never ran `attachActor`. That is a wiring bug, not a
    // client error, so it surfaces as a 500 rather than as a message telling a
    // user to sign in - which would send them looking for a sign-in page that
    // does not exist.
    throw new Error(
      'No actor is attached to this request. attachActor must be mounted before any router that uses these guards.',
    )
  }

  return req.user
}

/**
 * Shared preamble for the guards: fetches the actor, or reports the wiring bug.
 *
 * Returns null when it has already passed a response on, so each guard reads as
 * "get the user, then decide".
 */
function requireActorAttached(req: Request, next: NextFunction): AuthenticatedUser | null {
  if (!req.user) {
    next(
      new Error(
        'No actor is attached to this request. attachActor must be mounted before any router that uses these guards.',
      ),
    )
    return null
  }

  return req.user
}
