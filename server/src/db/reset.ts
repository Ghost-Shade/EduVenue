/**
 * Reset the database to a clean, freshly seeded state.
 *
 * Drops every table, applies the schema, then seeds the demo dataset. This is
 * the command to run when the demo data has been edited into a confusing state
 * during rehearsal.
 *
 * Run with:  npm run db:reset
 *
 * ===========================================================================
 * IT REFUSES TO RUN AGAINST A REMOTE DATABASE WITHOUT --force
 * ===========================================================================
 *
 * The SQLite version of this script deleted a file, which was safe because the
 * file was always on this machine. `DATABASE_URL` is now a full connection
 * string, and it is entirely possible to have the Neon URL for a deployed
 * instance exported in the same shell. Running this against it would drop the
 * tables behind a live site.
 *
 * So a host that is not local is refused unless `--force` is passed explicitly:
 *
 *     npm run db:reset -- --force
 *
 * The check is on the HOSTNAME, not on a flag, so it works even when nobody
 * remembered to set NODE_ENV.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getConfig } from '../config.ts'
import { closePool, redactDatabaseUrl, waitForDatabase } from './connection.ts'
import { applySchema, dropAllTables, listIndexes, listTables } from './migrate.ts'
import { seedDatabase } from './seed.ts'

/** Hosts that are certainly this machine. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])

function isLocalDatabase(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname
    return LOCAL_HOSTS.has(host) || host.endsWith('.local')
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const config = getConfig()
  const force = process.argv.includes('--force')

  console.log(`Resetting: ${redactDatabaseUrl(config.databaseUrl)}`)

  if (!isLocalDatabase(config.databaseUrl) && !force) {
    throw new Error(
      'That DATABASE_URL points at a remote host, and this command DROPS EVERY TABLE.\n' +
        'If you are certain, run it again with --force:\n\n' +
        '  npm run db:reset -- --force\n',
    )
  }

  await waitForDatabase()

  await dropAllTables()
  console.log('Dropped existing tables.')

  await applySchema()
  console.log('Schema applied.')

  await seedDatabase()
  console.log('Sample data seeded.')

  const tables = await listTables()
  const indexes = await listIndexes()

  // Called out explicitly rather than left to the index list: this constraint is
  // the entire no-overlap guarantee, and a reset that silently installed
  // everything except it would look perfectly healthy until two bookings raced.
  const hasOverlapConstraint = indexes.includes('bookings_no_overlap')

  console.log('')
  console.log(`Tables:             ${tables.length}`)
  console.log(`Indexes:            ${indexes.length}`)
  console.log(
    `Overlap constraint: ${hasOverlapConstraint ? 'installed (bookings_no_overlap)' : 'MISSING - this is a bug'}`,
  )
  console.log('')
  console.log('Reset complete.')
  console.log('No sign-in: the application opens as Brian Otieno, a class representative.')
  console.log('Every other demo identity is selectable from the switcher in the header.')

  if (!hasOverlapConstraint) {
    throw new Error(
      'The bookings_no_overlap exclusion constraint was not created. ' +
        'The no-overlap guarantee is NOT in place - investigate before using this database.',
    )
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error('\nReset failed.')
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await closePool()
  }
}
