/**
 * Configuration loading and validation.
 *
 * Design rule: fail loudly at startup, never at runtime.
 *
 * A missing SESSION_SECRET discovered when a user tries to log in at 3 AM is
 * far worse than a missing SESSION_SECRET discovered when the server boots. So
 * every requirement is checked here, once, with a message that says exactly
 * what to do about it.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The `server/` directory. Relative DATABASE_FILE paths resolve against this. */
export const SERVER_ROOT = path.resolve(here, '..')

/** The repository root, one level above `server/`. Holds `.env`. */
export const REPO_ROOT = path.resolve(here, '../..')

// Load `.env` from the repository root explicitly rather than relying on
// process.cwd(). npm scripts run with different working directories depending
// on how they are invoked, and a silently unloaded .env produces confusing
// "missing environment variable" errors.
dotenv.config({ path: path.join(REPO_ROOT, '.env') })

export type NodeEnv = 'development' | 'production' | 'test'

export interface AppConfig {
  nodeEnv: NodeEnv
  isProduction: boolean
  isTest: boolean

  port: number
  sessionSecret: string

  /** Absolute path to the SQLite file in use, or ':memory:' for tests. */
  databaseFile: string

  /** Whether the demo-account shortcuts should be offered on the sign-in page. */
  enableDemoLogins: boolean

  /** Built client assets, served by Express in production. */
  clientDistDir: string

  repoRoot: string
  serverRoot: string
}

/** Thrown when the environment is not usable. Blocks startup. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

function readNodeEnv(): NodeEnv {
  const raw = (process.env.NODE_ENV ?? 'development').trim()
  if (raw === 'development' || raw === 'production' || raw === 'test') {
    return raw
  }
  throw new ConfigurationError(
    `NODE_ENV must be one of "development", "production" or "test", received "${raw}".`,
  )
}

function readPort(): number {
  const raw = (process.env.PORT ?? '4000').trim()
  const port = Number(raw)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`PORT must be an integer between 1 and 65535, received "${raw}".`)
  }

  return port
}

function readSessionSecret(nodeEnv: NodeEnv): string {
  const secret = process.env.SESSION_SECRET?.trim() ?? ''

  // Tests never create real sessions, so the placeholder is tolerated there.
  // Everywhere else a weak secret is a genuine vulnerability: it is the only
  // thing preventing a forged session cookie.
  if (nodeEnv === 'test' && secret === '') {
    return 'test-only-secret-not-used-for-real-sessions'
  }

  if (secret === '') {
    throw new ConfigurationError(
      'SESSION_SECRET is not set. Copy .env.example to .env and generate one with:\n' +
        "  PowerShell: -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })",
    )
  }

  if (secret.length < 32) {
    throw new ConfigurationError(
      `SESSION_SECRET must be at least 32 characters to be worth signing with, received ${secret.length}. ` +
        'Generate a longer one with the PowerShell command above.',
    )
  }

  if (secret.startsWith('replace-me')) {
    throw new ConfigurationError(
      'SESSION_SECRET is still the placeholder value from .env.example. Generate a real one.',
    )
  }

  return secret
}

function readDatabaseFile(nodeEnv: NodeEnv): string {
  // Tests get a separate database so that running the suite can never destroy
  // the development data that the demo depends on.
  const raw =
    nodeEnv === 'test'
      ? (process.env.TEST_DATABASE_FILE ?? '../data/eduvenue.test.db')
      : (process.env.DATABASE_FILE ?? '../data/eduvenue.db')

  const trimmed = raw.trim()

  if (trimmed === ':memory:') {
    return ':memory:'
  }

  // Relative paths are resolved against server/ rather than cwd, so the value
  // in .env means the same thing however the process was started.
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(SERVER_ROOT, trimmed)
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function loadConfig(): AppConfig {
  const nodeEnv = readNodeEnv()
  const isProduction = nodeEnv === 'production'

  return {
    nodeEnv,
    isProduction,
    isTest: nodeEnv === 'test',

    port: readPort(),
    sessionSecret: readSessionSecret(nodeEnv),
    databaseFile: readDatabaseFile(nodeEnv),

    // Demo logins are convenient but must never be silently on in production.
    enableDemoLogins: isProduction ? false : readBoolean(process.env.ENABLE_DEMO_LOGINS, true),

    clientDistDir: path.join(REPO_ROOT, 'client', 'dist'),
    repoRoot: REPO_ROOT,
    serverRoot: SERVER_ROOT,
  }
}

/**
 * The single validated configuration object for the process.
 *
 * Exported as a lazily-initialised value so that importing this module has no
 * side effects until configuration is actually needed. That keeps the pure
 * modules (lib/overlap.ts, lib/time.ts) and their unit tests free of any
 * dependency on a configured environment.
 */
let cached: AppConfig | null = null

export function getConfig(): AppConfig {
  cached ??= loadConfig()
  return cached
}

/** Test-only: clears the cached configuration so the next read re-loads it. */
export function resetConfigCache(): void {
  cached = null
}
