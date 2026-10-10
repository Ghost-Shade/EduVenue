/**
 * Authentication routes.
 *
 * Shapes:
 *   POST /api/auth/login   -> { user }
 *   POST /api/auth/logout  -> 204 No Content
 *   GET  /api/auth/me      -> { user | null }
 *   GET  /api/auth/demo-accounts -> { accounts, password } when demo mode is on
 *
 * There is no registration route. See the note in services/authService.ts for
 * why allowing self-service sign-up would defeat the role model.
 */
import { Router } from 'express'

import { getConfig } from '../config.ts'
import { DEMO_PASSWORD } from '../db/seed.ts'
import { badRequest, unauthenticated } from '../lib/errors.ts'
import { ROLE_LABELS } from '../lib/roles.ts'
import { loginSchema, parseOrThrow } from '../lib/validation.ts'
import { currentUser, requireAuth } from '../middleware/auth.ts'
import { asyncHandler } from '../middleware/errorHandler.ts'
import { authenticate, listDemoAccounts } from '../services/authService.ts'
import { recordAudit } from '../services/auditService.ts'
import {
  createSession,
  purgeExpiredSessions,
  revokeSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from '../services/sessionService.ts'

export const authRouter = Router()

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(loginSchema, req.body, badRequest)

    const user = await authenticate(input.email, input.password)

    if (!user) {
      // Deliberately identical for an unknown address and a wrong password.
      // The audit entry records the attempt without recording the password.
      await recordAudit({
        actorId: null,
        action: 'auth.login_failed',
        entityType: 'profile',
        entityId: null,
        metadata: { email: input.email },
      })

      throw unauthenticated('Those credentials were not recognised.')
    }

    // Opportunistic housekeeping, so expired rows do not accumulate without a
    // background scheduler to supervise.
    await purgeExpiredSessions()

    const { token } = await createSession(user.id, req.get('user-agent') ?? null)

    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(getConfig().isProduction))

    await recordAudit({
      actorId: user.id,
      action: 'auth.login',
      entityType: 'profile',
      entityId: user.id,
      metadata: { role: user.role },
    })

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        roleLabel: ROLE_LABELS[user.role],
        department: user.department,
      },
    })
  }),
)

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // A cookie that no longer resolves still clears cleanly. Signing out twice
    // is not an error.
    if (req.sessionToken) {
      const user = req.user
      await revokeSession(req.sessionToken)

      if (user) {
        await recordAudit({
          actorId: user.id,
          action: 'auth.logout',
          entityType: 'profile',
          entityId: user.id,
          metadata: {},
        })
      }
    }

    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    res.status(204).end()
  }),
)

authRouter.get('/me', (req, res) => {
  if (!req.user) {
    res.json({ user: null })
    return
  }

  const user = currentUser(req)

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      department: user.department,
    },
  })
})

/**
 * Demo account listing for the sign-in page shortcuts.
 *
 * Enabled only when `ENABLE_DEMO_LOGINS` is true, which config.ts forces to
 * false in production. The shared password is included because it is already
 * printed on the sign-in page and in the README - withholding it here while
 * publishing it there would be security theatre. The guard that matters is that
 * these accounts hold nothing but sample data.
 *
 * This route queries the database rather than reading a list cached on
 * `app.locals` at startup. On a serverless platform the application is built
 * once per cold start and must not touch the database to do it, so the query
 * moved here; the listing is cheap and nothing polls it.
 */
authRouter.get(
  '/demo-accounts',
  asyncHandler(async (_req, res) => {
    const config = getConfig()

    if (!config.enableDemoLogins) {
      res.json({ accounts: [], password: null, enabled: false })
      return
    }

    const accounts = await listDemoAccounts()

    res.json({ accounts, password: DEMO_PASSWORD, enabled: true })
  }),
)

/** Confirms authentication works, for tests and smoke checks. */
authRouter.get('/protected-check', requireAuth, (req, res) => {
  res.json({ ok: true, role: currentUser(req).role })
})
