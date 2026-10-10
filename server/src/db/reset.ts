/**
 * Reset the database to a clean, freshly seeded state.
 *
 * Deletes the database file (including its write-ahead log companions), applies
 * the schema, then seeds the demo dataset. This is the command to run when the
 * demo data has been edited into a confusing state during rehearsal.
 *
 * Run with:  npm run db:reset
 *
 * Refuses to run against the test database when NODE_ENV is not 'test' only in
 * the sense that it always targets whatever the current configuration points
 * at - so check which file is printed before confirming.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getConfig } from '../config.ts'
import { openDatabase } from './connection.ts'
import { applySchema } from './migrate.ts'
import { seedDatabase, DEMO_PASSWORD } from './seed.ts'

function removeDatabaseFiles(databaseFile: string): void {
  if (databaseFile === ':memory:') {
    // Nothing to delete; an in-memory database vanishes with the process.
    return
  }

  // WAL mode keeps a -wal and a -shm file beside the database. Deleting only
  // the main file would leave committed transactions behind in the log, which
  // SQLite would then replay into the fresh database - producing a reset that
  // silently did not reset.
  const companions = [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]

  for (const file of companions) {
    if (fs.existsSync(file)) {
      fs.rmSync(file)
      console.log(`Removed ${path.basename(file)}`)
    }
  }
}

function main(): void {
  const config = getConfig()

  console.log(`Resetting: ${config.databaseFile}`)
  removeDatabaseFiles(config.databaseFile)

  const db = openDatabase(config.databaseFile)
  try {
    applySchema(db)
    console.log('Schema applied.')

    seedDatabase(db)
    console.log('Sample data seeded.')
    console.log('')
    console.log(`Demo password for all accounts: ${DEMO_PASSWORD}`)
    console.log('Reset complete.')
  } finally {
    db.close()
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error('\nReset failed.')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
