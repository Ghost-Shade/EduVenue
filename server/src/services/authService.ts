/**
 * Authentication.
 *
 * Two security properties are implemented here rather than left as intentions:
 *
 *  1. UNIFORM FAILURE. A wrong password and an unknown email produce the same
 *     error, so the endpoint cannot be used to discover which addresses have
 *     accounts.
 *
 *  2. UNIFORM TIMING. When no account matches, we still perform a bcrypt
 *     comparison against a dummy hash. Without that, the "unknown user" path
 *     returns roughly 100ms faster than the "wrong password" path, and that
 *     difference is measurable over the network - which would leak the same
 *     information the uniform error message was meant to hide.
 *
 * Public registration is deliberately NOT implemented. Allowing anyone to
 * choose their own role would hand out representative and administrator
 * privileges to anonymous users, which is the exact escalation the brief warns
 * about. Accounts are created by seeding or by an administrator.
 */
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

import { db, type Queryable } from '../db/connection.ts'
import { isUserRole, type UserRole } from '../lib/roles.ts'

export interface UserRecord {
  id: string
  email: string
  displayName: string
  role: UserRole
  department: string | null
  passwordHash: string
}

interface RawUserRow {
  id: string
  email: string
  display_name: string
  password_hash: string
  role: string
  department: string | null
}

function mapUserRow(row: RawUserRow): UserRecord | null {
  // A role value that is not recognised must never be silently coerced to a
  // default. Fail closed: treat the account as unusable and let it be fixed.
  if (!isUserRole(row.role)) {
    console.error(
      `[auth] profile ${row.id} has an unrecognised role "${row.role}" and cannot sign in`,
    )
    return null
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    department: row.department,
    passwordHash: row.password_hash,
  }
}

const SELECT_USER = `
  select id, email, display_name, password_hash, role, department
    from profiles
   where email = @email
`

/** Finds an account by email, or null. */
export async function findUserByEmail(
  email: string,
  q: Queryable = db,
): Promise<UserRecord | null> {
  const row = await q.queryOne<RawUserRow>(SELECT_USER, {
    email: email.trim().toLowerCase(),
  })

  return row ? mapUserRow(row) : null
}

/** Finds an account by id, or null. */
export async function findUserById(
  id: string,
  q: Queryable = db,
): Promise<UserRecord | null> {
  const row = await q.queryOne<RawUserRow>(
    `select id, email, display_name, password_hash, role, department
       from profiles
      where id = @id`,
    { id },
  )

  return row ? mapUserRow(row) : null
}

/**
 * A bcrypt hash used only to burn the same amount of time as a real
 * comparison when no account matches. Computed once, lazily, from random
 * input - so it can never accidentally match a real password.
 */
let dummyHash: string | null = null

function getDummyHash(): string {
  dummyHash ??= bcrypt.hashSync(randomBytes(32).toString('hex'), 10)
  return dummyHash
}

/**
 * Verifies an email and password.
 *
 * Returns the user on success, or null for every kind of failure. The caller
 * turns null into one indistinguishable error.
 */
export async function authenticate(email: string, password: string): Promise<UserRecord | null> {
  const user = await findUserByEmail(email)

  if (!user) {
    // Spend the time a real comparison would have taken, then fail.
    await bcrypt.compare(password, getDummyHash())
    return null
  }

  const matches = await bcrypt.compare(password, user.passwordHash)
  return matches ? user : null
}

/** Hashes a password for storage. Used by the seed script and administrator account creation. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export interface DemoAccount {
  email: string
  displayName: string
  role: UserRole
  department: string | null
}

/**
 * The demo accounts, for the sign-in page's shortcut buttons.
 *
 * Discovered from the database by the reserved `.test` domain rather than read
 * from the seed module, so the list reflects what is actually present - a
 * database seeded before an account was added simply lists fewer of them.
 *
 * This lives here rather than inside the route because it is a query, and it
 * used to run at STARTUP, in `createApp`. That does not work on a serverless
 * platform, where building the application must not require a database
 * connection: the module would be evaluated on every cold start, and a database
 * that is briefly unavailable would fail the deployment rather than one request.
 * Running it per request costs one query on a route nobody calls in a hot loop.
 */
export async function listDemoAccounts(q: Queryable = db): Promise<DemoAccount[]> {
  // The quoted literal contains something that looks like a named parameter.
  // compileNamedQuery copies single-quoted spans verbatim, which is what keeps
  // this statement working - see db/connection.ts.
  const rows = await q.query<{
    email: string
    display_name: string
    role: string
    department: string | null
  }>(
    `select email, display_name, role, department
       from profiles
      where email like '%@eduvenue.test'
      order by case role
                 when 'admin' then 1
                 when 'supervisor' then 2
                 when 'rep' then 3
                 else 4
               end,
               email`,
  )

  const accounts: DemoAccount[] = []

  for (const row of rows) {
    // Same rule as mapUserRow: an unrecognised role is never coerced into a
    // default, so it is omitted from the list rather than mislabelled.
    if (!isUserRole(row.role)) continue
    accounts.push({
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      department: row.department,
    })
  }

  return accounts
}
