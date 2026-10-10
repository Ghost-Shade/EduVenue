/**
 * Schema migration.
 *
 * Applies `schema.sql` to the configured database. The schema is written to be
 * fully idempotent (`create table if not exists`, `create or replace function`,
 * `drop trigger if exists`), so running it repeatedly is safe and there is no
 * migration-version table to keep in sync. That is a deliberate hackathon
 * simplification: a half-finished migration cannot leave the database in a
 * state that blocks startup.
 *
 * This schema is NEW, not migrated. There is no PostgreSQL database in the
 * world holding data in an earlier version of this shape - the move to
 * PostgreSQL was made from a SQLite file, which is not carried across. So the
 * `if not exists` clauses exist for repeatability, not for upgrading a live
 * database in place, and a change to a column's shape needs `db:reset`.
 *
 * Run with:  npm run db:migrate        (from the repository root)
 *        or  npm run db:migrate        (from server/)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { executeRaw, query, waitForDatabase } from './connection.ts'
import { getConfig } from '../config.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to the schema file shipped alongside this module. */
export const SCHEMA_PATH = path.join(here, 'schema.sql')

/** Thrown when the schema file is missing or fails to apply. */
export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MigrationError'
  }
}

/** Every table this schema owns, children before parents. */
export const APPLICATION_TABLES = [
  'audit_logs',
  'bookings',
  'facility_blocks',
  'facilities',
  'facility_categories',
  'booking_reference_seq',
  'profiles',
] as const

/**
 * Reads and executes schema.sql.
 *
 * Sent as ONE statement string rather than split on semicolons. The file
 * contains `$$`-quoted PL/pgSQL function bodies whose semicolons are not
 * statement separators, so a naive split would corrupt them - and the simple
 * query protocol PostgreSQL uses for a parameterless query handles a
 * multi-statement string natively.
 *
 * Through `executeRaw`, NOT `query`: this is DDL, and the named-parameter
 * compiler that `query` applies would treat a `@` in a comment as a placeholder
 * it was never given a value for. See connection.ts.
 */
export async function applySchema(schemaPath: string = SCHEMA_PATH): Promise<void> {
  if (!fs.existsSync(schemaPath)) {
    throw new MigrationError(`Schema file not found at "${schemaPath}".`)
  }

  const sql = fs.readFileSync(schemaPath, 'utf8')

  try {
    await executeRaw(sql)
  } catch (cause) {
    throw new MigrationError(
      `Failed to apply the schema from "${schemaPath}". ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    )
  }
}

/**
 * Drops every table this schema owns.
 *
 * Deliberately drops TABLES rather than the whole schema. Dropping `public`
 * would take `btree_gist` with it, and the extension is what makes the
 * no-overlap constraint possible - so a reset that also tore down the thing the
 * guarantee depends on would be answering the wrong question. The extension
 * stays installed; only the data goes.
 */
export async function dropAllTables(): Promise<void> {
  // `cascade` resolves the foreign-key ordering for us, so this list does not
  // have to stay in dependency order.
  await executeRaw(`drop table if exists ${APPLICATION_TABLES.join(', ')} cascade`)
}

/**
 * Recreates a named schema from scratch.
 *
 * Used by the test suite: each test file gets its own schema, so files that
 * `node --test` runs in parallel cannot observe each other's rows, and no test
 * run can reach the development data.
 *
 * The name is validated even though every caller generates it internally,
 * because it is interpolated into DDL that cannot be parameterised.
 */
export async function recreateSchema(schemaName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
    throw new MigrationError(`Refusing to use "${schemaName}" as a schema name.`)
  }

  await executeRaw(`drop schema if exists ${schemaName} cascade`)
  await executeRaw(`create schema ${schemaName}`)
}

/** Names of the tables currently present, for verification output. */
export async function listTables(): Promise<string[]> {
  // current_schema() is the first entry on the search_path, so this reports the
  // tables the application will actually read - the test schema when one is
  // pinned, and `public` otherwise.
  const rows = await query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = current_schema()
        and table_type = 'BASE TABLE'
      order by table_name`,
  )

  return rows.map((row) => row.table_name)
}

/**
 * Names of the indexes currently present, for verification output.
 *
 * Includes the index PostgreSQL builds for the no-overlap exclusion constraint,
 * so the reset output shows the guarantee being installed rather than merely
 * asserting that it was.
 */
export async function listIndexes(): Promise<string[]> {
  const rows = await query<{ indexname: string }>(
    `select indexname
       from pg_indexes
      where schemaname = current_schema()
      order by indexname`,
  )

  return rows.map((row) => row.indexname)
}

async function main(): Promise<void> {
  await waitForDatabase()
  await applySchema()

  const tables = await listTables()
  const indexes = await listIndexes()

  console.log(`Schema applied to ${getConfig().databaseSchema ?? 'public'}.`)
  console.log(`Tables (${tables.length}): ${tables.join(', ')}`)
  console.log(`Indexes (${indexes.length}): ${indexes.join(', ')}`)
  console.log('Schema applied successfully.')
}

// Only run when executed directly, so that tests can import the helpers above
// without triggering a migration of the development database.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error('\nMigration failed.')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    const { closePool } = await import('./connection.ts')
    await closePool()
  }
}
