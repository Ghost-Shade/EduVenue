/**
 * SQLite connection management.
 *
 * ===========================================================================
 * WHY THIS FILE MATTERS FOR CORRECTNESS
 * ===========================================================================
 *
 * Conflict prevention depends on the booking check and the booking insert being
 * atomic. Two properties of this setup provide that:
 *
 *   1. better-sqlite3 is a SYNCHRONOUS driver. A transaction body runs to
 *      completion without yielding, and Node is single-threaded, so no other
 *      JavaScript - and therefore no other HTTP request - can interleave
 *      part-way through it.
 *
 *   2. `inImmediateTransaction` issues BEGIN IMMEDIATE, which takes SQLite's
 *      write lock at the START of the transaction rather than lazily at the
 *      first write. This matters because the default deferred transaction
 *      begins as a reader, and two deferred transactions can both read the
 *      pre-state and then deadlock or fail at write time. IMMEDIATE makes the
 *      second writer wait its turn, so it observes the first one's committed
 *      row and correctly reports a conflict.
 *
 * Together these mean two simultaneous booking requests for the same slot are
 * genuinely serialised: exactly one succeeds.
 *
 * The `busy_timeout` pragma is what makes "wait its turn" work instead of
 * throwing SQLITE_BUSY immediately.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import { getConfig } from '../config.ts'

export type Db = Database.Database

let instance: Db | null = null

/** Thrown when the database file cannot be opened or prepared. */
export class DatabaseOpenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DatabaseOpenError'
  }
}

/**
 * Opens a SQLite connection with the pragmas this application relies on.
 *
 * Exported separately from `getDb` so that migrations and tests can open a
 * connection to an arbitrary path.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    // better-sqlite3 will not create missing parent directories, and the
    // failure message ("unable to open database file") does not mention that.
    // Creating it here turns a cryptic error into a non-event.
    const directory = path.dirname(file)
    try {
      fs.mkdirSync(directory, { recursive: true })
    } catch (cause) {
      throw new DatabaseOpenError(`Could not create the database directory "${directory}".`, {
        cause,
      })
    }
  }

  let db: Db
  try {
    db = new Database(file)
  } catch (cause) {
    throw new DatabaseOpenError(
      `Could not open the SQLite database at "${file}". ` +
        'If better-sqlite3 failed to build, see the Troubleshooting section of the README.',
      { cause },
    )
  }

  // Foreign keys are OFF by default in SQLite. Without this, every
  // `references` clause in schema.sql is decorative and the ON DELETE
  // RESTRICT rule that protects booking history would not be enforced.
  db.pragma('foreign_keys = ON')

  // Write-Ahead Logging lets reads proceed while a write transaction is open.
  // Ignored for in-memory databases, where SQLite reports "memory" instead.
  db.pragma('journal_mode = WAL')

  // Full fsync on every commit is unnecessary under WAL and dominates the cost
  // of small writes. NORMAL is the standard, safe pairing with WAL.
  db.pragma('synchronous = NORMAL')

  // Wait up to 5 seconds for a competing writer instead of failing instantly.
  // This is what turns a concurrent booking into a correct rejection rather
  // than a SQLITE_BUSY error.
  db.pragma('busy_timeout = 5000')

  return db
}

/** The process-wide connection. Created on first use. */
export function getDb(): Db {
  if (!instance) {
    instance = openDatabase(getConfig().databaseFile)
  }
  return instance
}

/** Closes the process-wide connection, if one is open. */
export function closeDb(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}

/**
 * Points the process-wide connection at a specific database file.
 *
 * The test harness needs this. Opening a connection with `openDatabase` alone is
 * not enough, because every service reaches for the connection through
 * `getDb()` - a test that opened its own handle would still be reading and
 * writing the development database, and would happily overwrite the demo data.
 */
export function useDatabase(file: string): Db {
  closeDb()
  instance = openDatabase(file)
  return instance
}

/**
 * Runs `fn` inside a single IMMEDIATE transaction, committing on return and
 * rolling back if it throws.
 *
 * Every operation that changes booking state goes through here. It is the
 * reason the "check for a conflict, then insert" sequence cannot race.
 *
 * Returns whatever `fn` returns. Do not perform async work inside `fn`: the
 * transaction is synchronous by design, and awaiting inside it would release
 * the lock mid-flight and destroy the guarantee.
 */
export function inImmediateTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate()
}

/**
 * Runs a read-only query function inside a deferred transaction, for
 * consistency across several SELECTs. Cheaper than IMMEDIATE because it does
 * not take the write lock.
 */
export function inReadTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn).deferred()
}

/**
 * Current time as a canonical UTC ISO-8601 string with milliseconds.
 *
 * `toISOString()` already produces exactly the fixed-width shape the schema's
 * CHECK constraints require, so this is a named alias rather than a formatter -
 * naming it makes the intent clear and gives us one place to change if the
 * storage format ever moves.
 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Converts a `Date` to the canonical stored representation. */
export function toStoredIso(instant: Date): string {
  return instant.toISOString()
}

/** Parses a stored timestamp back into a `Date`. */
export function fromStoredIso(value: string): Date {
  return new Date(value)
}
