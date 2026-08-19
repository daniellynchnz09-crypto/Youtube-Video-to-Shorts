import Database from 'better-sqlite3'
import { migrate } from './migrate.js'

/**
 * Opens a SQLite handle at the given path and brings it up to the current
 * schema. `dbPath` is passed in rather than hardcoded so the same code works
 * against both the smoke-test's scratch dir and Electron's real userData dir.
 */
export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}
