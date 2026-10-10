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
 */

process.env['NODE_ENV'] = 'test'

// An in-memory database per test file. Nothing the suite does can touch
// data/eduvenue.db, and each test file starts from a freshly seeded world
// because `node --test` runs every file in its own child process.
process.env['TEST_DATABASE_FILE'] = ':memory:'

// A literal secret rather than the empty-string shortcut in config.ts, so the
// test run exercises the same code path a real environment does. It is not a
// credential for anything: no test starts a server reachable off this machine.
process.env['SESSION_SECRET'] = 'eduvenue-test-secret-no-real-sessions-use-this'

export const TEST_ENV_READY = true
