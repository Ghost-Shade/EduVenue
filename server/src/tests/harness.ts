/**
 * Shared test harness: a throwaway database, sign-in helpers, and a real HTTP
 * server for the tests that must exercise the whole request path.
 *
 * Importing this module must be preceded by nothing - it imports `env.ts` first
 * itself, so a test file only needs:
 *
 *     import { prepareTestDatabase, signInAs } from './harness.ts'
 */
import './env.ts'

import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { applySchema } from '../db/migrate.ts'
import { seedDatabase } from '../db/seed.ts'
import { useDatabase, type Db } from '../db/connection.ts'
import { createApp } from '../index.ts'
import { addDaysToLocalDate, combineLocalDateTimeToUtc, toLocalDateString, type LocalDateString } from '../lib/time.ts'
import type { FacilityRecord } from '../services/facilityService.ts'
import {
  createSession,
  findSessionUser,
  SESSION_COOKIE_NAME,
  type AuthenticatedUser,
} from '../services/sessionService.ts'

let prepared = false

/**
 * Opens a fresh in-memory database, applies the schema and seeds it.
 *
 * Idempotent, so the several test files that call it at module load cost
 * nothing after the first call. `.immediate()`-style write locking is not used
 * during setup: the harness runs before any test, on a database only this
 * process can see.
 */
export function prepareTestDatabase(): Db {
  const db = useDatabase(':memory:')

  if (!prepared) {
    applySchema(db)
    seedDatabase(db)
    prepared = true
  }

  return db
}

/** Every demo user id, so tests do not have to hard-code them at each call site. */
export const TEST_USER_IDS = {
  admin: 'user-admin',
  rep: 'user-rep-brian',
  rep2: 'user-rep-cynthia',
  supervisor: 'user-supervisor',
  student: 'user-student',
} as const

export interface TestSession {
  user: AuthenticatedUser
  token: string
  /** Ready-made `Cookie` header value. */
  cookie: string
}

/**
 * Creates a real session for a user and returns the resolved user.
 *
 * Deliberately goes through sessionService rather than constructing an
 * `AuthenticatedUser` by hand: it means a change to the session shape breaks
 * these tests instead of letting them pass against a fiction. It also skips
 * bcrypt, which the login route would run - one test in api.test.ts covers the
 * real login route separately, so the cost is paid once.
 */
export function signInAs(userId: string): TestSession {
  const { token } = createSession(userId, 'test-harness')

  const user = findSessionUser(token)
  if (!user) {
    throw new Error(`Could not sign in as "${userId}" - the session did not resolve to a user.`)
  }

  return { user, token, cookie: `${SESSION_COOKIE_NAME}=${token}` }
}

/** Local weekday (0 = Sunday) of a local date, evaluated in campus terms. */
export function localWeekday(date: LocalDateString): number {
  const middayUtc = combineLocalDateTimeToUtc(date, '12:00')
  return new Date(middayUtc.getTime() + 12 * 60 * 60 * 1000).getUTCDay()
}

/**
 * A local date at least `minDaysAhead` away on which `facility` is open.
 *
 * The default of 10 days is chosen deliberately: the seed data only covers days
 * -10 to +4 relative to today, so a date this far out is guaranteed free of
 * every seeded booking and block. Tests that need "a completely empty day" can
 * therefore be deterministic without inspecting the seed at all.
 */
export function openDateFor(facility: FacilityRecord, minDaysAhead = 10): LocalDateString {
  let candidate = addDaysToLocalDate(toLocalDateString(new Date()), minDaysAhead)

  for (let attempt = 0; attempt < 21; attempt += 1) {
    if (!facility.closedDays.includes(localWeekday(candidate))) {
      return candidate
    }
    candidate = addDaysToLocalDate(candidate, 1)
  }

  throw new Error(
    `No open date found for ${facility.name} within 3 weeks of ${minDaysAhead} days from today.`,
  )
}

const allocatedDates = new Set<string>()

/**
 * A date for a test, never handed out twice for the same facility.
 *
 * Two tests asking for "11 days ahead" and "12 days ahead" receive the SAME
 * date whenever the earlier one has to skip a Sunday, and they would then
 * interfere with each other's bookings. Every call here returns a date that is
 * at least `minDaysAhead` away, open for that facility, and untouched by any
 * earlier caller.
 */
export function allocateOpenDate(facility: FacilityRecord, minDaysAhead = 10): LocalDateString {
  for (let ahead = minDaysAhead; ahead < minDaysAhead + 40; ahead += 1) {
    const date = openDateFor(facility, ahead)
    const key = `${facility.id}|${date}`

    if (!allocatedDates.has(key)) {
      allocatedDates.add(key)
      return date
    }
  }

  throw new Error(`Ran out of unused dates for ${facility.name}.`)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface TestServer {
  baseUrl: string
  close: () => Promise<void>
}

/**
 * Starts the real Express application on an ephemeral port.
 *
 * `listen(0)` lets the operating system pick a free port, so the suite never
 * collides with a development server already running on 4000.
 */
export async function startTestServer(): Promise<TestServer> {
  prepareTestDatabase()

  const app = createApp()
  const server: Server = app.listen(0)

  await once(server, 'listening')

  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

export interface HttpResponse {
  status: number
  body: unknown
  headers: Headers
}

/** A small JSON fetch wrapper that can carry a session cookie. */
export async function apiRequest(
  server: TestServer,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.cookie) {
    headers['Cookie'] = options.cookie
  }

  const response = await fetch(`${server.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  const text = await response.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  return { status: response.status, body, headers: response.headers }
}

/** Extracts the session cookie from a login response, ready for reuse. */
export function sessionCookieFrom(response: HttpResponse): string {
  const setCookie =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/)

  const match = setCookie.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))
  if (!match) {
    throw new Error('The login response did not set a session cookie.')
  }

  const [pair] = match.split(';')
  return pair ?? ''
}

/** Narrowing helper for reading an error code out of an API error body. */
export function errorCode(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code: unknown }).code
      if (typeof code === 'string') return code
    }
  }
  return null
}
