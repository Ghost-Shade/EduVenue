/**
 * Express Request augmentation.
 *
 * `req.user` is populated ONLY by the session middleware, from a server-side
 * session row. It is never read from a request body, query string or header,
 * which is what makes role escalation through edited client state impossible.
 *
 * The properties are optional because a request passes through middleware in
 * order: on a public route they are simply never set.
 */
import type { AuthenticatedUser } from '../services/sessionService.ts'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `attachUser` when a valid session cookie is present. */
      user?: AuthenticatedUser

      /** Raw session token, needed by logout in order to revoke the row. */
      sessionToken?: string
    }
  }
}

export {}
