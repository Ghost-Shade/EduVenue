/**
 * Who you are acting as.
 *
 * ===========================================================================
 * THIS IS NOT AUTHENTICATION, AND THE NAME SAYS SO
 * ===========================================================================
 *
 * There are no passwords, no session tokens, no server-side session rows and no
 * expiry. A cookie carries the id of a profile, and the server believes it. Any
 * caller can send any id.
 *
 * That is a deliberate choice for a prototype whose entire dataset is invented
 * sample data, and it is documented as such in README.md and in the schema
 * comment on `profiles`. It is called "identity", never "auth", so that nobody
 * reads a security property into it that is not there.
 *
 * WHAT IS STILL REAL, AND WHY THE IDENTITY IS WORTH KEEPING
 *
 * Dropping the credential layer does NOT mean dropping the actor. Three things
 * genuinely depend on knowing who is acting, and all three still work:
 *
 *   - OWNERSHIP. `bookings.booked_by` records who booked, and only that person
 *     (or an administrator) may cancel it.
 *   - THE ROLE MODEL. A facility's `min_role` and `booking_policy` decide who
 *     may book it. A medical lab requiring a supervisor is still refused to a
 *     student, and that refusal is still enforced on the server.
 *   - THE AUDIT TRAIL. `audit_logs.actor_id` records who did what.
 *
 * So the RULES are enforced exactly as before; only the claim "and we know that
 * you really are Brian" is gone. A booking system where everyone is anonymous
 * could not have ownership, roles or an audit trail at all - which is why a
 * fixed anonymous actor was the wrong answer and a chosen identity was the right
 * one.
 *
 * ===========================================================================
 * HOW THE IDENTITY TRAVELS
 * ===========================================================================
 *
 * One cookie, holding a profile id, `httpOnly` so a script cannot set it and
 * `SameSite=Lax` so a cross-site POST cannot carry it. With no credential to
 * steal there is nothing to sign, so the cookie is not signed and does not need
 * to be.
 *
 * When the cookie is ABSENT OR UNRESOLVABLE the server falls back to
 * `DEFAULT_ACTOR_ID`, so the application is never in a signed-out state and
 * there is no login step to remove. That also means a stale cookie left over
 * from a previous seed - pointing at a profile that no longer exists - degrades
 * to the default instead of producing an empty, broken session.
 */
import { db, type Queryable } from '../db/connection.ts'
import { isUserRole, ROLE_LABELS, type UserRole } from '../lib/roles.ts'

/** The identity attached to a request. Never taken from a request body. */
export interface AuthenticatedUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  department: string | null
}

/** Name of the cookie carrying the chosen profile id. */
export const IDENTITY_COOKIE_NAME = 'eduvenue_actor'

/**
 * Who you are when you have not chosen.
 *
 * A class representative, because that is the role the application is about:
 * representatives are the ones who book, so the default experience is the
 * primary one rather than a read-only tour. Every other role is one click away
 * in the switcher.
 */
export const DEFAULT_ACTOR_ID = 'user-rep-brian'

interface RawProfileRow {
  id: string
  email: string
  display_name: string
  role: string
  department: string | null
}

/**
 * Narrows a profile row, or null if it is unusable.
 *
 * An unrecognised role is never coerced to a default. Fail closed: the account
 * cannot act, and the reason is logged, rather than being silently downgraded to
 * `student` - which would hide the corruption while appearing to work.
 */
function mapProfileRow(row: RawProfileRow): AuthenticatedUser | null {
  if (!isUserRole(row.role)) {
    console.error(
      `[identity] profile ${row.id} has an unrecognised role "${row.role}" and cannot act`,
    )
    return null
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    department: row.department,
  }
}

/**
 * Resolves a profile id to an identity, or null.
 *
 * This is the single door through which an acting user is established, whether
 * the id came from a cookie or from the default constant.
 */
export async function findIdentity(
  userId: string,
  q: Queryable = db,
): Promise<AuthenticatedUser | null> {
  if (!userId) return null

  const row = await q.queryOne<RawProfileRow>(
    `select id, email, display_name, role, department
       from profiles
      where id = @userId`,
    { userId },
  )

  return row ? mapProfileRow(row) : null
}

/**
 * The identity for a request, given whatever its cookie held.
 *
 * Always returns a user. An absent, unknown or corrupt cookie yields the default
 * actor, because a signed-out state no longer exists - there is nothing to sign
 * out of.
 */
export async function resolveActor(
  cookieValue: string | undefined,
  q: Queryable = db,
): Promise<AuthenticatedUser> {
  if (cookieValue) {
    const chosen = await findIdentity(cookieValue, q)
    if (chosen) return chosen

    // Logged rather than ignored: a cookie pointing at nothing usually means the
    // database was re-seeded while a browser kept the old value, and knowing
    // that saves a confusing debugging session.
    console.warn(
      `[identity] cookie named profile "${cookieValue}", which does not exist. ` +
        `Falling back to ${DEFAULT_ACTOR_ID}. Re-seeding resets ids.`,
    )
  }

  const fallback = await findIdentity(DEFAULT_ACTOR_ID, q)

  if (!fallback) {
    throw new Error(
      `The default identity "${DEFAULT_ACTOR_ID}" is missing from the database. ` +
        'The demo data has not been seeded - run `npm run db:reset`.',
    )
  }

  return fallback
}

/** One selectable identity, for the switcher. */
export interface IdentityOption {
  id: string
  email: string
  displayName: string
  role: UserRole
  roleLabel: string
  department: string | null
}

export interface IdentityListing {
  /** The identity currently acting. */
  current: AuthenticatedUser
  /** Everyone that can be chosen. */
  available: IdentityOption[]
}

interface RawListingRow {
  id: string
  email: string
  display_name: string
  role: string
  department: string | null
}

/**
 * Every identity that can be chosen, most privileged first.
 *
 * Discovered from the database rather than from the seed module, so the list is
 * whatever is actually present - a database seeded before an account was added
 * simply lists fewer of them, instead of offering a name that does not resolve
 * when it is clicked.
 *
 * A row whose role is unrecognised is omitted rather than shown with a guessed
 * label, matching the rule in `mapProfileRow`: an unusable account is never
 * papered over with a default.
 */
export async function listIdentities(q: Queryable = db): Promise<IdentityOption[]> {
  const rows = await q.query<RawListingRow>(
    `select id, email, display_name, role, department
       from profiles
      order by case role
                 when 'admin' then 1
                 when 'supervisor' then 2
                 when 'rep' then 3
                 else 4
               end,
               display_name`,
  )

  const identities: IdentityOption[] = []

  for (const row of rows) {
    if (!isUserRole(row.role)) continue
    identities.push({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      roleLabel: ROLE_LABELS[row.role],
      department: row.department,
    })
  }

  return identities
}

/**
 * Cookie options for the identity cookie.
 *
 * `httpOnly` so a script cannot rewrite it, `SameSite=Lax` so a cross-site POST
 * cannot carry it. `secure` only in production, because the development server
 * is plain HTTP. There is no `maxAge`: this is a session cookie that dies with
 * the browser, which is the honest lifetime for a choice with no expiry behind
 * it.
 */
export function identityCookieOptions(isProduction: boolean): {
  httpOnly: boolean
  sameSite: 'lax'
  secure: boolean
  path: string
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
  }
}
