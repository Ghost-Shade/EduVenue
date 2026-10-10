/**
 * Test environment setup. MUST be the first import in every test file that
 * touches the database, the configuration or the HTTP application.
 * ===========================================================================
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * `config.ts` reads `process.env` when it is first asked for configuration.
 * Setting `NODE_ENV=test` from the command line would be platform-specific
 * (`NODE_ENV=test node ...` is not valid in cmd.exe, which is what npm uses on
 * Windows by default), so it is set here instead.
 *
 * This is a LEAF module on purpose: it imports nothing from the application, so
 * it is evaluated to completion the instant it is imported - before `config.ts`
 * is reached. That ordering is the whole point. If it imported `config.ts`, the
 * configuration would already have been read under the wrong environment.
 *
 * `dotenv.config()` in config.ts does NOT overwrite variables that are already
 * present in `process.env`. Values set here therefore win over any `.env` file,
 * which is what stops a developer's `.env` from pointing the test run at the
 * development database.
 *
 * ===========================================================================
 * ISOLATION: ONE SCHEMA PER TEST FILE
 * ===========================================================================
 *
 * Postgres replaces the old in-memory SQLite file, and an in-memory database is
 * the one thing Postgres cannot offer. What it offers instead is schemas, and
 * `node --test` runs every test file in its OWN CHILD PROCESS - so a schema
 * chosen per process gives exactly the isolation the in-memory file gave.
 *
 * The schema name is derived from the test file's name rather than randomised,
 * so that a second run REUSES and recreates it instead of leaving a new schema
 * behind on every run. A persistent Docker volume would otherwise accumulate
 * schemas until the database was unreadable.
 *
 * The schema is pinned through the connection's `options` (see config.ts and
 * db/connection.ts), not with a one-off `set search_path`: the pool hands out
 * connections indiscriminately, so a per-session setting would apply to exactly
 * one of them and the rest of the test would run against `public`.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const LOCAL_TEST_DATABASE_URL =
  'postgres://eduvenue:eduvenue_local_only@localhost:5433/eduvenue_test'

process.env['NODE_ENV'] = 'test'

// The test database is a SEPARATE database from the development one, so even a
// bug in the schema teardown below cannot reach development data. The `??=`
// means an explicit value from the shell or CI wins, while a value in `.env`
// does not: `.env` is loaded later by config.ts, and dotenv never overwrites
// what is already set.
process.env['TEST_DATABASE_URL'] ??= LOCAL_TEST_DATABASE_URL

// A literal secret rather than the empty-string shortcut in config.ts, so the
// test run exercises the same code path a real environment does. It is not a
// credential for anything: no test starts a server reachable off this machine.
process.env['SESSION_SECRET'] = 'eduvenue-test-secret-no-real-sessions-use-this'

/**
 * A schema name for this test file, matching the conservative identifier shape
 * config.ts validates. Derived from the file so it is stable between runs.
 */
function deriveSchemaName(): string {
  const entry = process.argv[1] ?? ''

  // Only a name derived from an actual test file is trusted. `node --test` runs
  // each file in its own child process whose argv[1] is that file - but if that
  // ever stops being true, the fallback below must not be reached with a
  // name-shaped-but-shared stem. A path like `.../node_modules/.../runner.js`
  // would reduce to the stem "runner", and EVERY test file would then pin the
  // same schema: isolation gone, quietly. Requiring the test-file shape turns
  // that into a unique random schema per process instead, which is merely
  // untidy rather than wrong.
  const stem = /\.test\.[cm]?[jt]sx?$/.test(path.basename(entry))
    ? path
        .basename(entry)
        // `api.test.ts`, `api.test.mts`, `api.test.js` all reduce to `api`.
        .replace(/\.test\.[cm]?[jt]sx?$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
    : ''

  // Falling back to a random name rather than a shared one: two files that both
  // failed to yield a name must not end up sharing a schema, which would
  // reintroduce exactly the cross-file interference this is here to prevent.
  return stem === '' ? `t_${randomUUID().replace(/-/g, '').slice(0, 12)}` : `t_${stem}`
}

process.env['DATABASE_SCHEMA'] = deriveSchemaName()

export const TEST_ENV_READY = true
