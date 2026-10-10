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

/** The `server/` directory. */
export const SERVER_ROOT = path.resolve(here, '..')

/** The repository root, one level above `server/`. Holds `.env`. */
export const REPO_ROOT = path.resolve(here, '../..')

// Load `.env` from the repository root explicitly rather than relying on
// process.cwd(). npm scripts run with different working directories depending
// on how they are invoked, and a silently unloaded .env produces confusing
// "missing environment variable" errors.
dotenv.config({ path: path.join(REPO_ROOT, '.env') })

export type NodeEnv = 'development' | 'production' | 'test'

/**
 * Local Postgres from docker-compose.yml.
 *
 * These are DEVELOPMENT defaults, not credentials: the container is bound to
 * this machine, and the password is published in docker-compose.yml. Production
 * has no default at all - the URL is injected by the Vercel/Neon integration,
 * and its absence is a configuration error rather than a silent fallback to
 * something local.
 */
const LOCAL_DEV_DATABASE_URL = 'postgres://eduvenue:eduvenue_local_only@localhost:5433/eduvenue'
const LOCAL_TEST_DATABASE_URL = 'postgres://eduvenue:eduvenue_local_only@localhost:5433/eduvenue_test'

export interface AppConfig {
  nodeEnv: NodeEnv
  isProduction: boolean
  isTest: boolean

  port: number
  sessionSecret: string

  /** PostgreSQL connection string. Never logged directly - see redactDatabaseUrl. */
  databaseUrl: string

  /**
   * Schema to pin `search_path` to.
   *
   * Set only by the test harness, which gives each test file its own schema so
   * that files `node --test` runs in parallel cannot see each other's rows.
   * Null everywhere else, which means the normal `public` schema.
   */
  databaseSchema: string | null

  /** Connection pool ceiling. Kept small: serverless instances multiply it. */
  databasePoolSize: number

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

function readDatabaseUrl(nodeEnv: NodeEnv): string {
  const fallback =
    nodeEnv === 'test'
      ? LOCAL_TEST_DATABASE_URL
      : nodeEnv === 'development'
        ? LOCAL_DEV_DATABASE_URL
        : ''

  const raw = (nodeEnv === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL) ?? ''
  const value = raw.trim() || fallback

  if (value === '') {
    throw new ConfigurationError(
      'DATABASE_URL is not set. Point it at a PostgreSQL database, for example:\n' +
        `  DATABASE_URL=${LOCAL_DEV_DATABASE_URL}\n\n` +
        'For local development, `docker compose up -d` starts one on port 5433.',
    )
  }

  if (!/^postgres(ql)?:\/\//.test(value)) {
    throw new ConfigurationError(
      'DATABASE_URL must be a PostgreSQL connection string beginning with ' +
        `"postgres://" or "postgresql://", received "${redact(value)}".`,
    )
  }

  return value
}

/**
 * The schema to pin `search_path` to, if any.
 *
 * Restricted to a conservative identifier shape because the value is
 * interpolated into the connection's `options` string. It is generated
 * internally rather than taken from a user, but a value that could carry a space
 * or a semicolon would silently change the connection's behaviour, so the shape
 * is enforced here rather than assumed.
 */
function readDatabaseSchema(nodeEnv: NodeEnv): string | null {
  // Only the test harness uses this. A schema override in production would mean
  // serving an application from a schema nobody expects it to be in.
  if (nodeEnv !== 'test') return null

  const raw = (process.env.DATABASE_SCHEMA ?? '').trim()
  if (raw === '') return null

  if (!/^[a-z_][a-z0-9_]*$/.test(raw)) {
    throw new ConfigurationError(
      `DATABASE_SCHEMA must match [a-z_][a-z0-9_]*, received "${redact(raw)}".`,
    )
  }

  return raw
}

function readDatabasePoolSize(): number {
  const raw = (process.env.DATABASE_POOL_MAX ?? '5').trim()
  const size = Number(raw)

  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw new ConfigurationError(
      `DATABASE_POOL_MAX must be an integer between 1 and 100, received "${raw}".`,
    )
  }

  return size
}

/**
 * Masks the password inside a connection string for safe inclusion in an error
 * message. A configuration error is often the first thing a developer pastes
 * into a chat window, and a DATABASE_URL carries a live credential.
 */
function redact(value: string): string {
  return value.replace(/:\/\/([^:@/]+):[^@/]*@/, '://$1:****@')
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
    databaseUrl: readDatabaseUrl(nodeEnv),
    databaseSchema: readDatabaseSchema(nodeEnv),
    databasePoolSize: readDatabasePoolSize(),

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
