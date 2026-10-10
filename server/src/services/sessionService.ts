/**
 * Server-side session management.
 *
 * ===========================================================================
 * WHY SERVER-SIDE SESSIONS RATHER THAN JWTs
 * ===========================================================================
 *
 * The cookie holds an opaque random token. The database holds only its SHA-256
 * hash. Three consequences, all of which matter here:
 *
 *  1. The token is revocable. Signing out deletes the row and the session is
 *     dead immediately. A JWT stays valid until it expires unless you build a
 *     revocation list - which is a session table with extra steps.
 *  2. A leaked database dump does not hand over live sessions, because the
 *     stored value is a hash the attacker cannot reverse into a cookie.
 *  3. Nothing about the user is encoded in the cookie, so there is no role
 *     claim to tamper with. Role is read from the `profiles` row on every
 *     request, so revoking someone's representative rights takes effect on
 *     their very next action rather than whenever a token happens to expire.
 *
 * SHA-256 rather than bcrypt is correct here: the token is 256 bits of CSPRNG
 * output, not a low-entropy human password, so there is nothing to brute-force
 * and a slow hash would only add latency to every request.
 */
import { createHash, randomBytes } from 'node:crypto'

import { db, execute, queryOne, type Queryable } from '../db/connection.ts'
import { isUserRole, type UserRole } from '../lib/roles.ts'

/** The identity attached to an authenticated request. Never built from client input. */
export interface AuthenticatedUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  department: string | null
}

/** Name of the session cookie. Prefixed to avoid collisions with other apps on localhost. */
export const SESSION_COOKIE_NAME = 'eduvenue_session'

/** How long a session remains valid without being refreshed. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface SessionRow {
  token_hash: string
  user_id: string
  expires_at: Date
  users_id: string | null
  email: string | null
  display_name: string | null
  name: string | null
  role: string | null
  department: string | null
}

/** Hash of a session token, as stored. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Generates a new opaque session token. 256 bits of CSPRNG output, URL-safe. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface CreatedSession {
  token: string
  expiresAt: string
}

/**
 * Creates a session for a user and returns the raw token.
 *
 * The raw token is returned exactly once, to be placed in the cookie. It is
 * never logged and never stored.
 */
export async function createSession(
  userId: string,
  userAgent: string | null,
  q: Queryable = db,
): Promise<CreatedSession> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await q.execute(
    `insert into sessions (token_hash, user_id, expires_at, user_agent)
     values (@tokenHash, @userId, @expiresAt, @userAgent)`,
    {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: userAgent ? userAgent.slice(0, 300) : null,
    },
  )

  return { token, expiresAt: expiresAt.toISOString() }
}

/**
 * Resolves a session token to a user.
 *
 * Returns null for an unknown, expired or otherwise unusable token.
 *
 * Expiry is compared against an instant passed FROM THIS PROCESS, not against
 * the database's `now()`. That is deliberate and it is a change from the SQLite
 * build, where `datetime('now')` ran inside the same process that issued the
 * session - the two clocks were the same clock by construction. They are not any
 * more, so one has to be chosen. `expires_at` is written from this process's
 * clock at creation (see createSession), so the comparison uses the same clock
 * on both sides: mixing in `now()` here would let a drifting host hand out a
 * session the database considered already expired, or keep one alive past the
 * lifetime the user was told. Honest limit: skew on THIS host shifts expiry with
 * it.
 *
 * The join is what makes role changes take effect immediately: the role comes
 * from `profiles`, not from the session row.
 */
export async function findSessionUser(token: string, q: Queryable = db): Promise<AuthenticatedUser | null> {
  if (!token) return null

  const row = await q.queryOne<SessionRow>(
    `select s.token_hash,
            s.user_id,
            s.expires_at,
            p.id           as users_id,
            p.email        as email,
            p.display_name as display_name,
            p.role         as role,
            p.department   as department
       from sessions s
       left join profiles p on p.id = s.user_id
      where s.token_hash = @tokenHash
        and s.expires_at > @now`,
    // `now` is bound as a parameter rather than written as the SQL function
    // now(), so the comparison uses the same clock that wrote `expires_at`.
    // See the note on expiry in this function's doc comment.
    { tokenHash: hashToken(token), now: new Date() },
  )

  // The profile may be missing if the account was deleted while a session was
  // live. Treat that as no session rather than as an anonymous user.
  if (!row || !row.users_id || !row.role || !isUserRole(row.role)) {
    return null
  }

  return {
    id: row.users_id,
    email: row.email ?? '',
    displayName: row.display_name ?? 'Unknown user',
    role: row.role,
    department: row.department ?? null,
  }
}

/**
 * Revokes a single session.
 *
 * Deleting a row that is already gone is not an error - signing out twice
 * should be idempotent, not a failure.
 */
export async function revokeSession(token: string, q: Queryable = db): Promise<void> {
  if (!token) return
  await q.execute('delete from sessions where token_hash = @tokenHash', {
    tokenHash: hashToken(token),
  })
}

/** Revokes every session for a user. Used when an account's role changes. */
export async function revokeAllSessionsForUser(userId: string, q: Queryable = db): Promise<number> {
  const result = await q.execute('delete from sessions where user_id = @userId', { userId })
  return result.rowCount
}

/**
 * Deletes expired sessions.
 *
 * Called opportunistically rather than on a timer, so the application has no
 * background scheduler to supervise. Returns the number of rows removed.
 */
export async function purgeExpiredSessions(q: Queryable = db): Promise<number> {
  const result = await q.execute('delete from sessions where expires_at <= @now', {
    now: new Date(),
  })
  return result.rowCount
}

/**
 * Cookie options for the session cookie.
 *
 * httpOnly  - JavaScript cannot read it, so an XSS bug cannot steal the session.
 * sameSite  - 'lax' blocks cross-site POSTs from carrying it, which is the main
 *             CSRF vector for a cookie-authenticated API.
 * secure    - only over HTTPS. Disabled in development because the dev server
 *             is plain HTTP; enabled otherwise.
 * path      - '/' so the cookie is sent for both API calls and page loads.
 */
export function sessionCookieOptions(isProduction: boolean): {
  httpOnly: boolean
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: SESSION_TTL_MS,
  }
}
