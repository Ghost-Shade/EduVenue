/**
 * Vercel serverless entrypoint.
 *
 * ===========================================================================
 * WHAT VERCEL DOES WITH THIS FILE
 * ===========================================================================
 *
 * `vercel.json` declares a service named `server`, and public traffic reaches it
 * through the rewrite:
 *
 *     { "source": "/api/(.*)", "destination": { "service": "server" } }
 *
 * Vercel passes the ORIGINAL path through, so a request to `/api/facilities`
 * arrives here as `/api/facilities` - not as `/facilities`. That matches the
 * Express router, which mounts everything under `/api` (see routes/index.ts).
 * The rewrite therefore needs no path-stripping, and this file needs to know
 * nothing about it.
 *
 * The exported Express app is the request handler: Vercel recognises a callable
 * default export as a Node.js handler.
 *
 * ===========================================================================
 * WHY THERE IS NO DATABASE WORK HERE
 * ===========================================================================
 *
 * This module is evaluated once per cold start and then reused. So it must not
 * wait for the database, must not assert the schema, and must not purge
 * sessions - all of that is per-process work that belongs in src/index.ts, which
 * runs as a long-lived server. A cold start that waits on a database is a cold
 * start that fails the moment the database is briefly unavailable.
 *
 * No bindings are declared for this service, and nothing here reads one. There
 * is nothing for this service to call over the network: it is the only backend,
 * and the client is a static build. A binding would inject an environment
 * variable that no code reads.
 */
import { createApp } from '../src/app.ts'

export default createApp()
