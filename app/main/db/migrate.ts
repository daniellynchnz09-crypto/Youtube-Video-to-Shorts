import type Database from 'better-sqlite3'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

/** Idempotent — safe to call on every app/script startup. */
export function migrate(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion >= SCHEMA_VERSION) return

  db.exec(SCHEMA_SQL)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}
