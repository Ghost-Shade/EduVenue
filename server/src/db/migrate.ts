/**
 * Schema migration.
 *
 * Applies `schema.sql` to the configured database. The schema is written to be
 * fully idempotent (`create table if not exists`, `drop trigger if exists`),
 * so running this repeatedly is safe and there is no migration-version table to
 * keep in sync. That is a deliberate hackathon simplification: it means a
 * half-finished migration cannot leave the database in a state that blocks
 * startup.
 *
 * Run with:  npm run db:migrate        (from the repository root)
 *        or  npm run db:migrate        (from server/)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getConfig } from '../config.ts'
import { openDatabase, type Db } from './connection.ts'

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

/**
 * Reads and executes schema.sql.
 *
 * Uses `exec` rather than `prepare`, because the schema contains multiple
 * statements including trigger bodies. SQLite parses those correctly through
 * exec, which a prepared statement cannot do.
 */
export function applySchema(db: Db, schemaPath: string = SCHEMA_PATH): void {
  if (!fs.existsSync(schemaPath)) {
    throw new MigrationError(`Schema file not found at "${schemaPath}".`)
  }

  const sql = fs.readFileSync(schemaPath, 'utf8')

  try {
    db.exec(sql)
  } catch (cause) {
    throw new MigrationError(
      `Failed to apply the schema from "${schemaPath}". ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    )
  }
}

/** Names of the user tables currently present, for verification output. */
export function listTables(db: Db): string[] {
  const rows = db
    .prepare(
      `select name
         from sqlite_master
        where type = 'table'
          and name not like 'sqlite_%'
        order by name`,
    )
    .all() as Array<{ name: string }>

  return rows.map((row) => row.name)
}

/** Names of the indexes currently present, for verification output. */
export function listIndexes(db: Db): string[] {
  const rows = db
    .prepare(
      `select name
         from sqlite_master
        where type = 'index'
          and name not like 'sqlite_%'
        order by name`,
    )
    .all() as Array<{ name: string }>

  return rows.map((row) => row.name)
}

function main(): void {
  const config = getConfig()

  console.log(`Applying schema to: ${config.databaseFile}`)

  const db = openDatabase(config.databaseFile)
  try {
    applySchema(db)

    const tables = listTables(db)
    const indexes = listIndexes(db)

    console.log(`Tables (${tables.length}): ${tables.join(', ')}`)
    console.log(`Indexes (${indexes.length}): ${indexes.join(', ')}`)
    console.log('Schema applied successfully.')
  } finally {
    db.close()
  }
}

// Only run when executed directly, so that tests can import the helpers above
// without triggering a migration of the development database.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error('\nMigration failed.')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
