/**
 * PostgreSQL connection management.
 *
 * ===========================================================================
 * WHY THIS FILE MATTERS FOR CORRECTNESS
 * ===========================================================================
 *
 * The project's central claim is that two confirmed bookings can never overlap
 * for the same facility, even when two representatives submit at the same
 * moment.
 *
 * That guarantee used to be provided here, by `BEGIN IMMEDIATE` against a single
 * SQLite file in a single process. It is no longer. It now lives in the database
 * itself, as an exclusion constraint on `bookings` (see schema.sql):
 *
 *     exclude using gist (
 *       facility_id with =,
 *       tstzrange(effective_start, effective_end) with &&
 *     ) where (status = 'confirmed')
 *
 * The constraint is strictly stronger than the old transaction form: it is
 * enforced inside an index, by the database, so it holds across processes,
 * across instances and across hosts. Nothing in this file has to be careful for
 * the guarantee to hold - which is the point of moving it.
 *
 * What this file still does is make the *round trip* honest: one named-parameter
 * compiler used by every statement, one place where a transaction is begun, and
 * a pool sized for the platform it is running on.
 *
 * ===========================================================================
 * NAMED PARAMETERS, DELIBERATELY
 * ===========================================================================
 *
 * Every SQL statement in this application was written with `@name` placeholders,
 * because that is what better-sqlite3 used. `pg` wants positional `$1`, `$2`.
 *
 * Rather than rewrite all 40-odd statements - and risk, in the same change as
 * swapping the driver, introducing a parameter-order bug that no test would
 * catch - `compileNamedQuery` translates `@name` to `$n` at the boundary. The
 * statements therefore stay exactly as they were and stay readable, and the
 * translation happens in one reviewed place.
 */
import pg from 'pg'

import { getConfig } from '../config.ts'

const { Pool } = pg

/** A row as it comes back from the driver, before mapping to a domain type. */
export type Row = Record<string, unknown>

/** Named parameter values, keyed by the name used in the SQL. */
export type QueryParams = Record<string, unknown>

export interface ExecuteResult {
  /** Rows affected, for statements where that is meaningful. */
  rowCount: number
}

/**
 * Anything that can run a query: the pool, or a single connection inside a
 * transaction.
 *
 * Service functions that MUST run inside the caller's transaction take one of
 * these as a parameter, rather than reaching for the module-level `db`. That is
 * what makes `performBookingWrite`'s checks and its insert genuinely occur in
 * the same transaction instead of merely appearing to.
 */
export interface Queryable {
  query<T = Row>(sql: string, params?: QueryParams): Promise<T[]>
  queryOne<T = Row>(sql: string, params?: QueryParams): Promise<T | undefined>
  execute(sql: string, params?: QueryParams): Promise<ExecuteResult>
}

/** Thrown when the database cannot be reached or a query cannot be compiled. */
export class DatabaseError extends Error {
  readonly code: string | undefined

  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options)
    this.name = 'DatabaseError'
    this.code = options?.code
  }
}

// ---------------------------------------------------------------------------
// SQLSTATE
//
// Postgres reports failures with a five-character SQLSTATE. Two of them are
// load-bearing here:
//
//   23P01 exclusion_violation - the no-overlap constraint rejected the insert.
//                                 This is the BACKSTOP, not the normal path:
//                                 the service checks first and produces a helpful
//                                 message, and this only fires if two requests
//                                 genuinely raced. It must still reach the user
//                                 as an ordinary 409 CONFLICT.
//   23505 unique_violation    - a duplicate booking reference or email.
// ---------------------------------------------------------------------------
export const SQLSTATE = {
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  invalidTextRepresentation: '22P02',
} as const

/** Reads the SQLSTATE out of an unknown thrown value, if it has one. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/** True when the failure was the no-overlap constraint rejecting a booking. */
export function isOverlapViolation(error: unknown): boolean {
  return sqlState(error) === SQLSTATE.exclusionViolation
}

// ---------------------------------------------------------------------------
// Named-parameter compilation
// ---------------------------------------------------------------------------

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char)
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/**
 * Rewrites `@name` placeholders as `$1`, `$2`, ... and collects the values.
 *
 * The same name used twice reuses the same positional parameter, so a query can
 * mention `@facilityId` in several places without repeating the value.
 *
 * SINGLE-QUOTED LITERALS ARE COPIED VERBATIM. This is required, not an
 * optimisation: `where email like '%@eduvenue.test'` contains something that is
 * textually identical to a named parameter, and compiling it would produce a
 * parameter that was never supplied.
 *
 * `@>` (the jsonb containment operator) survives because its `@` is followed by
 * `>`, which is not an identifier character.
 */
export function compileNamedQuery(
  sql: string,
  params: QueryParams = {},
): { text: string; values: unknown[] } {
  const values: unknown[] = []
  const positions = new Map<string, number>()
  let text = ''
  let index = 0

  while (index < sql.length) {
    const char = sql[index]

    if (char === "'") {
      const start = index
      index += 1
      while (index < sql.length) {
        if (sql[index] === "'") {
          // A doubled '' is an escaped quote inside the literal, not its end.
          if (sql[index + 1] === "'") {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      text += sql.slice(start, index)
      continue
    }

    if (char === '@' && isIdentifierStart(sql[index + 1])) {
      let end = index + 1
      while (end < sql.length && isIdentifierPart(sql[end])) end += 1

      const name = sql.slice(index + 1, end)
      let position = positions.get(name)

      if (position === undefined) {
        const value = params[name]

        // `undefined` is treated as "not supplied" so that a typo in a
        // parameter name surfaces as an error rather than as a NULL that
        // silently changes what the query matches. Pass `null` for a real NULL.
        if (value === undefined) {
          throw new DatabaseError(
            `Query parameter "@${name}" was not provided. ` +
              `Pass null explicitly if a NULL value was intended.`,
          )
        }

        values.push(value)
        position = values.length
        positions.set(name, position)
      }

      text += `$${position}`
      index = end
      continue
    }

    text += char
    index += 1
  }

  return { text, values }
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

type Runner = (text: string, values: unknown[] | undefined) => Promise<pg.QueryResult>

function makeQueryable(run: Runner): Queryable {
  /**
   * Passing `undefined` rather than an empty array matters.
   *
   * `pg` chooses its protocol by the presence of the values argument: no values
   * means the SIMPLE query protocol, which happily executes a string containing
   * several statements separated by semicolons. An empty array means the
   * EXTENDED protocol, which prepares the string as a single statement and
   * rejects anything after the first semicolon.
   *
   * schema.sql is applied as one multi-statement string, so getting this wrong
   * would break migration rather than merely slow it down.
   */
  const exec = (text: string, values: unknown[]): Promise<pg.QueryResult> =>
    run(text, values.length > 0 ? values : undefined)

  return {
    async query<T = Row>(sql: string, params?: QueryParams): Promise<T[]> {
      const { text, values } = compileNamedQuery(sql, params)
      const result = await exec(text, values)
      return result.rows as T[]
    },

    async queryOne<T = Row>(sql: string, params?: QueryParams): Promise<T | undefined> {
      const { text, values } = compileNamedQuery(sql, params)
      const result = await exec(text, values)
      return result.rows[0] as T | undefined
    },

    async execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
      const { text, values } = compileNamedQuery(sql, params)
      const result = await exec(text, values)
      return { rowCount: result.rowCount ?? 0 }
    },
  }
}

let pool: pg.Pool | null = null

/**
 * The connection pool. Created on first use, so that importing this module has
 * no side effects - which is what keeps the pure unit tests configuration-free.
 *
 * For tests, `search_path` is pinned on every new connection by `DATABASE_SCHEMA`
 * (see config.ts). It has to be a connection-level setting rather than a one-off
 * `set search_path`, because the pool hands out connections indiscriminately and
 * a per-session setting would apply to exactly one of them.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const config = getConfig()

    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolSize,
      // Drop idle connections quickly: on a serverless platform an instance may
      // be frozen at any moment, and holding sockets open across a freeze only
      // produces stale connections that fail on resume.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // `public` stays on the path so that the btree_gist operator classes,
      // installed once into `public`, remain visible from a test schema.
      options: config.databaseSchema
        ? `-c search_path=${config.databaseSchema},public`
        : undefined,
    })

    // A pool-level error is emitted for a connection that fails while idle. Left
    // unhandled it becomes an unhandled 'error' event and takes the process
    // down; logged, it is a reconnect on the next request.
    pool.on('error', (error) => {
      console.error('[db] idle client error:', error.message)
    })
  }

  return pool
}

/** Closes the pool. Called on shutdown so the process can exit cleanly. */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool
    pool = null
    await closing.end()
  }
}

/** The process-wide query interface. */
export const db: Queryable = makeQueryable((text, values) => getPool().query(text, values))

/** Runs a query and returns every row. */
export function query<T = Row>(sql: string, params?: QueryParams): Promise<T[]> {
  return db.query<T>(sql, params)
}

/** Runs a query and returns the first row, or undefined. */
export function queryOne<T = Row>(sql: string, params?: QueryParams): Promise<T | undefined> {
  return db.queryOne<T>(sql, params)
}

/** Runs a statement and reports how many rows it affected. */
export function execute(sql: string, params?: QueryParams): Promise<ExecuteResult> {
  return db.execute(sql, params)
}

/**
 * Runs SQL exactly as written, with NO named-parameter compilation.
 *
 * DDL belongs here, and the reason is sharper than tidiness. `compileNamedQuery`
 * scans for `@name` outside single-quoted literals and throws on one it was not
 * supplied a value for - correct for a query, wrong for a schema file, where a
 * `@` in a comment or a regex is ordinary text. `schema.sql` today contains
 * exactly one `@`, the `@>` of a jsonb operator inside a comment, and it
 * survives only because `>` cannot start an identifier. A future comment reading
 * `-- @todo`, or a regex containing `@`, would fail the migration with an error
 * about a missing query parameter - in the one code path that installs the
 * no-overlap guarantee. Keeping DDL off the compiler makes that impossible
 * rather than merely unlikely.
 *
 * Like `query`, a statement with nothing to bind is sent with no parameter list
 * at all, which selects the simple protocol and lets a single string carry
 * several statements - which is how schema.sql is applied.
 */
export function executeRaw(sql: string): Promise<ExecuteResult> {
  return getPool()
    .query(sql)
    .then((result) => ({ rowCount: result.rowCount ?? 0 }))
}

/**
 * Runs `fn` inside a single transaction, committing on success and rolling back
 * on any throw.
 *
 * `fn` receives a `Queryable` bound to that one connection. IT MUST USE IT. A
 * statement issued through the module-level `db` would be taken from the pool
 * and could run on a *different* connection, outside the transaction - a mistake
 * that is invisible until it matters, which is exactly the kind of bug the
 * explicit parameter is here to make impossible.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect()

  try {
    await client.query('begin')
    const result = await fn(makeQueryable((text, values) => client.query(text, values)))
    await client.query('commit')
    return result
  } catch (error) {
    try {
      await client.query('rollback')
    } catch (rollbackError) {
      // Reported but not thrown: the original failure is what matters, and
      // replacing it with a rollback error would hide the real cause.
      console.error('[db] rollback failed:', rollbackError)
    }
    throw error
  } finally {
    client.release()
  }
}

/**
 * Waits for the database to accept queries, retrying for a short while.
 *
 * A freshly started container (or a Neon branch that has just been created) can
 * refuse connections for a second or two. Failing instantly there would produce
 * an error about credentials when the real situation is "it is not up yet".
 */
export async function waitForDatabase(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  for (;;) {
    try {
      await query('select 1')
      return
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)

  throw new DatabaseError(
    `Could not reach the database after ${Math.round(timeoutMs / 1000)}s.\n` +
      `  DATABASE_URL: ${redactDatabaseUrl(getConfig().databaseUrl)}\n` +
      `  Last error:   ${detail}\n\n` +
      'For local development, start the bundled PostgreSQL:\n\n' +
      '  docker compose up -d\n\n' +
      'then run `npm run db:reset` from the repository root.',
    { cause: lastError },
  )
}

/**
 * Hides the password in a connection string so it is safe to print.
 *
 * Anything that echoes configuration to a terminal or a log has to go through
 * this: a DATABASE_URL typically carries a live credential.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) {
      parsed.password = '****'
    }
    return parsed.toString()
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

/** Current time as a canonical ISO-8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Normalises a `timestamptz` column to a `Date`.
 *
 * `pg` returns these as `Date` already. The tolerance for strings is for a
 * column that has been defined as `text`, or a value that has been through
 * `jsonb` - in both cases getting a usable Date is better than throwing deep
 * inside a mapper.
 */
export function asInstant(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Normalises a `timestamptz` column to a canonical ISO-8601 UTC string. */
export function asInstantIso(value: Date | string): string {
  return asInstant(value).toISOString()
}
