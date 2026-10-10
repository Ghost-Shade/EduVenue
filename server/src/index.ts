/**
 * EduVenue API server.
 *
 * Boot sequence:
 *   1. Load and validate configuration (fails fast, with an actionable message).
 *   2. Check the database has been migrated, and say so clearly if it has not.
 *   3. Build the Express application.
 *   4. Listen.
 *
 * Express serves BOTH the API under /api and, when a production build exists,
 * the compiled client. Serving them from one origin means the session cookie
 * needs no CORS configuration and no `credentials: 'include'` juggling - the
 * browser treats it as an ordinary same-site cookie.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cookieParser from 'cookie-parser'
import express, { type Express } from 'express'

import { getConfig } from './config.ts'
import { closeDb, getDb } from './db/connection.ts'
import { DEMO_PASSWORD } from './db/seed.ts'
import { attachUser } from './middleware/auth.ts'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts'
import { createApiRouter } from './routes/index.ts'
import { purgeExpiredSessions } from './services/sessionService.ts'

/**
 * Confirms the schema is present.
 *
 * Running against an unmigrated database produces "no such table: bookings"
 * from deep inside a request handler, which reads like an application bug. This
 * turns it into an instruction instead.
 */
function assertDatabaseReady(): void {
  const row = getDb()
    .prepare(`select name from sqlite_master where type = 'table' and name = 'bookings'`)
    .get() as { name: string } | undefined

  if (!row) {
    throw new Error(
      'The database has no schema yet.\n' +
        'Run this first, from the repository root:\n\n' +
        '  npm run db:reset\n\n' +
        '(db:reset applies the schema and seeds the demo data.)',
    )
  }
}

/**
 * Publishes the demo accounts to the sign-in page, if demo mode is enabled.
 *
 * Read from the database rather than from the seed module, so the list reflects
 * what is actually present. The shared password is only exposed when demo mode
 * is on, which config.ts forces off in production.
 */
function publishDemoAccounts(app: Express): void {
  const config = getConfig()
  if (!config.enableDemoLogins) return

  const rows = getDb()
    .prepare(
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
    .all() as Array<{
    email: string
    display_name: string
    role: string
    department: string | null
  }>

  app.locals.demoAccounts = rows.map((row) => ({
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    department: row.department,
  }))
  app.locals.demoPassword = DEMO_PASSWORD
}

/**
 * Minimal security headers.
 *
 * Deliberately a handful of explicit headers rather than the `helmet`
 * dependency: for a JSON API served to a same-origin client, these are the ones
 * that matter, and spelling them out keeps the tradeoff visible.
 */
function securityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    // Stop the browser from reinterpreting a JSON response as HTML or script.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // The API is never meant to be framed.
    res.setHeader('X-Frame-Options', 'DENY')
    // Do not leak the full URL (which can contain ids) to third parties.
    res.setHeader('Referrer-Policy', 'same-origin')
    next()
  }
}

export function createApp(): Express {
  const config = getConfig()
  const app = express()

  // Behind a proxy in production, so `secure` cookies are recognised. Not set
  // in development, where trusting a proxy header would be wrong.
  if (config.isProduction) {
    app.set('trust proxy', 1)
  }

  app.disable('x-powered-by')

  app.use(securityHeaders())
  app.use(cookieParser())
  // Bounded body size: nothing this API accepts is large, and an unbounded
  // JSON parser is a trivial denial-of-service vector.
  app.use(express.json({ limit: '100kb' }))

  // Decides who the caller is, if anyone. Never rejects.
  app.use(attachUser)

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'eduvenue-api' })
  })

  app.use('/api', createApiRouter())

  // Any unmatched /api path must produce JSON, not the HTML fallback below.
  app.use('/api', notFoundHandler)

  // Serve the compiled client when it exists. In development the Vite dev
  // server handles this instead and proxies /api here.
  if (fs.existsSync(config.clientDistDir)) {
    app.use(express.static(config.clientDistDir))

    // Single-page-app fallback: unknown non-API paths return index.html so
    // client-side routing works on a hard refresh.
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(config.clientDistDir, 'index.html'))
    })
  }

  app.use(errorHandler)

  // Populated here rather than in main(), so that a test which builds the app
  // gets the same sign-in shortcuts a real server would serve.
  publishDemoAccounts(app)

  return app
}

function main(): void {
  const config = getConfig()

  assertDatabaseReady()

  // Clear stale sessions at boot so the table does not grow without bound
  // between logins.
  const purged = purgeExpiredSessions()
  if (purged > 0) {
    console.log(`Removed ${purged} expired session(s).`)
  }

  const app = createApp()

  const server = app.listen(config.port, () => {
    console.log('')
    console.log('  EduVenue API')
    console.log(`  http://localhost:${config.port}`)
    console.log(`  Database:   ${config.databaseFile}`)
    console.log(`  Environment: ${config.nodeEnv}`)
    console.log(`  Demo logins: ${config.enableDemoLogins ? 'enabled' : 'disabled'}`)
    console.log('')
    console.log('  All facility data is illustrative sample data.')
    console.log('')

    if (!config.enableDemoLogins) {
      console.warn('  WARNING: demo logins are disabled but this is not production.')
    }
  })

  const shutdown = (signal: string): void => {
    console.log(`\nReceived ${signal}. Shutting down.`)
    server.close(() => {
      closeDb()
      process.exit(0)
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
    main()
  } catch (error) {
    console.error('\nEduVenue failed to start.\n')
    console.error(error instanceof Error ? error.message : error)
    console.error('')
    process.exitCode = 1
  }
}
