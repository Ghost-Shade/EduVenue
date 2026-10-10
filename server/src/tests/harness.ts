/**
 * Shared test harness: a throwaway schema, sign-in helpers, and a real HTTP
 * server for the tests that must exercise the whole request path.
 *
 * Importing this module must be preceded by nothing - it imports `env.ts` first
 * itself, so a test file only needs:
 *
 *     import { prepareTestDatabase, signInAs } from './harness.ts'
 *
 * Everything here is ASYNC now, because every database call is a network round
 * trip. `prepareTestDatabase()` must be awaited before any service call, and
 * `signInAs` too. Forgetting is a compile error rather than a silent race,
 * because the functions no longer have synchronous return types.
 */
import './env.ts'

import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { after } from 'node:test'

import { createApp } from '../app.ts'
import { getConfig } from '../config.ts'
import { applySchema, recreateSchema } from '../db/migrate.ts'
import { closePool, waitForDatabase } from '../db/connection.ts'
import { seedDatabase } from '../db/seed.ts'
import {
  addDaysToLocalDate,
  combineLocalDateTimeToUtc,
  toLocalDateString,
  type LocalDateString,
} from '../lib/time.ts'
import type { FacilityRecord } from '../services/facilityService.ts'
import {
  createSession,
  findSessionUser,
  SESSION_COOKIE_NAME,
  type AuthenticatedUser,
} from '../services/sessionService.ts'

/**
 * Releases the connection pool when the file's tests finish.
 *
 * Registered HERE rather than left to each test file, because forgetting it is
 * not a failing test - it is a test run that HANGS. An open pool keeps idle
 * sockets, an idle socket keeps the event loop alive, and `node --test` waits
 * for the child process to exit. The file would simply never finish, with no
 * error explaining why.
 *
 * `node --test` gives each file its own process, and ESM evaluates this module
 * once, so exactly one hook is registered per process.
 */
after(async () => {
  await closePool()
})

let prepared = false

/**
 * Creates this test file's schema, applies the schema and seeds it.
 *
 * Idempotent, so the several places that call it at module load cost nothing
 * after the first call.
 *
 * `drop ... cascade` then `create` rather than trusting an empty schema: the
 * database PERSISTS between runs (it is a Docker volume), so the previous run's
 * tables are still there. Recreating is what makes a second run behave like the
 * first one, which is the whole point of a test database.
 */
export async function prepareTestDatabase(): Promise<void> {
  if (prepared) return

  const schema = getConfig().databaseSchema
  if (!schema) {
    throw new Error(
      'DATABASE_SCHEMA is not set, so tests would run against the public schema. ' +
        'tests/env.ts should have set it - check that it is imported before anything else.',
    )
  }

  // A container that has just been started refuses connections for a moment.
  // This turns that into the actionable "start Docker" message rather than a
  // raw ECONNREFUSED from whichever test happened to run first.
  await waitForDatabase()

  await recreateSchema(schema)
  await applySchema()
  await seedDatabase()

  prepared = true
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
export async function signInAs(userId: string): Promise<TestSession> {
  const { token } = await createSession(userId, 'test-harness')

  const user = await findSessionUser(token)
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
 * The UTC instants bounding a local calendar date.
 *
 * Replaces the SQLite-era `start_time like '2026-05-04%'`, which worked only
 * because timestamps were stored as ISO text. `timestamptz` is a real instant,
 * so "on this local date" is a half-open range - which is also the correct
 * comparison, since it uses the index on start_time.
 */
export function localDateBounds(date: LocalDateString): { from: Date; to: Date } {
  return {
    from: combineLocalDateTimeToUtc(date, '00:00'),
    to: combineLocalDateTimeToUtc(addDaysToLocalDate(date, 1), '00:00'),
  }
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
  await prepareTestDatabase()

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
