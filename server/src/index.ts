/**
 * EduVenue API server - the long-running entrypoint.
 *
 * Boot sequence:
 *   1. Load and validate configuration (fails fast, with an actionable message).
 *   2. Wait for the database to accept connections.
 *   3. Check it has been migrated, and say so clearly if it has not.
 *   4. Build the Express application.
 *   5. Listen.
 *
 * The application itself is built in app.ts, which is shared with the
 * serverless entrypoint (api/index.ts) and with the tests. Everything in THIS
 * file is about being a long-lived process: waiting for a database that may
 * still be starting, clearing stale sessions once at boot, and closing the pool
 * on a signal. None of that belongs in the app factory, and none of it runs on
 * Vercel.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from './app.ts'
import { getConfig } from './config.ts'
import { closePool, query, redactDatabaseUrl, waitForDatabase } from './db/connection.ts'
import { purgeExpiredSessions } from './services/sessionService.ts'

/**
 * Confirms the schema is present.
 *
 * Running against an unmigrated database produces `relation "bookings" does not
 * exist` from deep inside a request handler, which reads like an application
 * bug. This turns it into an instruction instead.
 *
 * The check is scoped to `current_schema()`, so it asks about the schema this
 * connection is actually using rather than about the database as a whole - which
 * is what makes it correct under a test's search_path as well as in `public`.
 */
async function assertDatabaseReady(): Promise<void> {
  const row = await query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = current_schema()
        and table_name = 'bookings'`,
  )

  if (row.length === 0) {
    throw new Error(
      'The database has no schema yet.\n' +
        'Run this first, from the repository root:\n\n' +
        '  npm run db:reset\n\n' +
        '(db:reset applies the schema and seeds the demo data.)',
    )
  }
}

async function main(): Promise<void> {
  const config = getConfig()

  // A Postgres container that has just been started refuses connections for a
  // moment. Failing instantly there would report a credentials problem when the
  // real situation is "not up yet".
  await waitForDatabase()

  await assertDatabaseReady()

  // Clear stale sessions at boot so the table does not grow without bound
  // between logins. Done once here rather than per request; on the serverless
  // entrypoint there is no boot to hook, so it is skipped there and expired rows
  // simply age out of every query that reads them.
  const purged = await purgeExpiredSessions()
  if (purged > 0) {
    console.log(`Removed ${purged} expired session(s).`)
  }

  const app = createApp()

  const server = app.listen(config.port, () => {
    console.log('')
    console.log('  EduVenue API')
    console.log(`  http://localhost:${config.port}`)
    console.log(`  Database:   ${redactDatabaseUrl(config.databaseUrl)}`)
    console.log(`  Environment: ${config.nodeEnv}`)
    console.log(`  Demo logins: ${config.enableDemoLogins ? 'enabled' : 'disabled'}`)
    console.log('')
    console.log('  All facility data is illustrative sample data.')
    console.log('')

    if (!config.enableDemoLogins) {
      console.warn('  WARNING: demo logins are disabled but this is not production.')
    }
  })

  let shuttingDown = false

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`\nReceived ${signal}. Shutting down.`)
    server.close(() => {
      // The pool must be closed, not merely dropped: an open connection keeps
      // the process alive after the server has stopped accepting requests.
      void closePool().then(() => process.exit(0))
    })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Only boot when this file is the program being run. Without the guard,
// importing `createApp` from a test would start a real server on the configured
// port, connect to the development database and then keep the test process
// alive until it was killed.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error('\nEduVenue failed to start.\n')
    console.error(error instanceof Error ? error.message : error)
    console.error('')
    process.exitCode = 1

    // Released ONLY on the failure path, and note why this is not a `finally`:
    // `main()` resolves as soon as `app.listen` has been called, so a `finally`
    // would close the pool on the SUCCESS path too - immediately after the
    // server started listening. The server would still work, because getPool()
    // lazily builds a replacement on the next query, but it would silently
    // discard the connections boot had already opened. Closing here instead
    // releases just the connections a failed boot managed to open, so the
    // process can exit rather than hang on a live socket.
    await closePool()
  }
}
