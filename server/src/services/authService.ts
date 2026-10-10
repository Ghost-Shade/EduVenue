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

import { getDb } from '../db/connection.ts'
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
   where email = ?
`

/** Finds an account by email, or null. */
export function findUserByEmail(email: string): UserRecord | null {
  const row = getDb()
    .prepare(SELECT_USER)
    .get(email.trim().toLowerCase()) as RawUserRow | undefined

  return row ? mapUserRow(row) : null
}

/** Finds an account by id, or null. */
export function findUserById(id: string): UserRecord | null {
  const row = getDb()
    .prepare(
      `select id, email, display_name, password_hash, role, department
         from profiles
        where id = ?`,
    )
    .get(id) as RawUserRow | undefined

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
  const user = findUserByEmail(email)

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
