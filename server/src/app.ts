/**
 * The Express application, with NO boot and NO database access.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM index.ts
 * ===========================================================================
 *
 * Building the application must not require a database connection. On Vercel the
 * module is evaluated once per cold start, and a builder that tries to query the
 * database there has two problems: it fails the whole deployment when the
 * database is briefly unreachable, and it pays a connection cost on every cold
 * start even for a request that needs none.
 *
 * So this file only wires middleware and routes together. Everything that needs
 * the database - checking the schema is present, resolving the acting identity -
 * happens later, per request, or in index.ts where a long-running process can
 * reasonably wait for one.
 *
 * Express serves BOTH the API under /api and, when a production build exists,
 * the compiled client. Serving them from one origin means the identity cookie
 * needs no CORS configuration and no `credentials: 'include'` juggling - the
 * browser treats it as an ordinary same-site cookie. (On Vercel the two are
 * separate services and Vite's dev server proxies instead, but the same-origin
 * property is preserved at the edge by the routing in vercel.json.)
 */
import fs from 'node:fs'
import path from 'node:path'

import cookieParser from 'cookie-parser'
import express, { type Express } from 'express'

import { getConfig } from './config.ts'
import { attachActor } from './middleware/identity.ts'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts'
import { createApiRouter } from './routes/index.ts'

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

  // Decides who the caller is acting as. This does NOT authenticate anybody -
  // see services/identityService.ts - but it does fail the request when the
  // lookup itself cannot be completed, rather than quietly defaulting every
  // caller to the same identity and attributing their actions to the wrong
  // person in the audit trail.
  app.use(attachActor)

  // Deliberately does NOT touch the database: it answers "is this process
  // serving?" and nothing else, so it stays useful when everything else is
  // broken. A health check that fails because the database is down tells you
  // less than one that stays up and lets the failing routes speak for
  // themselves.
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

  return app
}
