/**
 * Express Request augmentation.
 *
 * `req.user` is populated ONLY by `attachActor` (middleware/identity.ts), from
 * either the identity cookie or the default identity. It is never read from a
 * request body, a query string or a header, which is what makes it impossible to
 * escalate a role by editing a request: the role always comes from the `profiles`
 * row the id points at.
 *
 * It is still OPTIONAL in this type, and now for a different reason than before.
 * It used to be optional because a public route might never set it. Every request
 * now gets one, so the optionality guards the narrower case of a router mounted
 * on an application that never ran `attachActor` - a wiring mistake that should
 * be a visible failure rather than a `req.user!` that hides it.
 */
import type { AuthenticatedUser } from '../services/identityService.ts'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `attachActor` on every request, falling back to the default identity. */
      user?: AuthenticatedUser
    }
  }
}

export {}
