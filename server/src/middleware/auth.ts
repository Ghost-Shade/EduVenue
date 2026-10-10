/**
 * Authentication and authorization middleware.
 *
 * ===========================================================================
 * AUTHORIZATION LIVES ON THE SERVER, ALWAYS
 * ===========================================================================
 *
 * The interface hides administrator buttons from students. That is a usability
 * decision, not a security control. Every privileged route is independently
 * guarded here, because a request can be sent with curl and never load the
 * interface at all.
 *
 * `attachUser` is best-effort and runs on every request. `requireAuth` and the
 * role guards are opt-in per route, so that a new public route cannot be
 * accidentally protected and a new protected route cannot be accidentally
 * public - the failure mode of a forgotten guard is a visible 401 in testing,
 * not a silent hole.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { forbidden, unauthenticated } from '../lib/errors.ts'
import { roleAtLeast, type UserRole } from '../lib/roles.ts'
import {
  findSessionUser,
  SESSION_COOKIE_NAME,
  type AuthenticatedUser,
} from '../services/sessionService.ts'

/**
 * Resolves the session cookie, if present, and attaches the user.
 *
 * Never rejects a request for lack of a session - an anonymous request simply
 * continues without `req.user`. That is what lets the same server serve public
 * routes such as the facility directory.
 *
 * IT DOES reject on a DATABASE failure, via `next(error)`, and that is
 * deliberate. Resolving a session is now a network call, and the tempting
 * shortcut - catch everything and continue as anonymous - would turn a database
 * blip into "everyone is signed out", with no error anywhere to explain it. The
 * routes this middleware fronts cannot be served without the database anyway, so
 * surfacing a 500 is both honest and no less available.
 */
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const cookies = req.cookies as Record<string, unknown> | undefined
  const token = cookies?.[SESSION_COOKIE_NAME]

  if (typeof token === 'string' && token.length > 0) {
    try {
      const user = await findSessionUser(token)
      if (user) {
        req.user = user
        req.sessionToken = token
      }
    } catch (error) {
      next(error)
      return
    }
  }

  next()
}

/** Rejects the request unless a valid session was attached. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(unauthenticated())
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
    if (!req.user) {
      next(unauthenticated())
      return
    }

    if (!allowed.includes(req.user.role)) {
      next(
        forbidden(
          `This action requires the ${allowed.join(' or ')} role. ` +
            `You are signed in as a ${req.user.role}.`,
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
    if (!req.user) {
      next(unauthenticated())
      return
    }

    if (!roleAtLeast(req.user.role, minimum)) {
      next(
        forbidden(
          `This action requires at least the ${minimum} role. ` +
            `You are signed in as a ${req.user.role}.`,
        ),
      )
      return
    }

    next()
  }
}

/**
 * The authenticated user, or a thrown error.
 *
 * Exists so that route handlers can obtain a non-optional user after
 * `requireAuth` without a non-null assertion, which would otherwise be needed
 * at every call site and would hide a genuine mistake if a route were ever
 * declared without the guard.
 */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw unauthenticated()
  }
  return req.user
}
