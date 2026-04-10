import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'path'
import postgres from 'postgres'
import * as schema from './schema'

// For postgres driver, DATABASE_URL is required
if (process.env.DATABASE_DRIVER === 'postgres' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required when DATABASE_DRIVER=postgres')
}

const isPglite = process.env.DATABASE_DRIVER !== 'postgres'

const pgliteDb = isPglite
  ? drizzlePglite({ client: new PGlite(process.env.DATABASE_URL), schema }) // undefined = in-memory
  : null

const postgresDb = isPglite ? null : drizzlePostgres({ client: postgres(process.env.DATABASE_URL!), schema })

export const db = pgliteDb ?? postgresDb!

/**
 * Run Drizzle migrations on startup.
 * Disable with SKIP_MIGRATIONS=true (e.g. when migrations are handled externally).
 *
 * Uses process.cwd() instead of import.meta.dir because compiled Bun binaries
 * resolve import.meta.dir to the executable's directory, not the source file's.
 */
export const runMigrations = async () => {
  if (process.env.SKIP_MIGRATIONS === 'true') return
  const migrationsFolder = resolve(process.cwd(), 'drizzle')
  if (pgliteDb) {
    await migratePglite(pgliteDb, { migrationsFolder })
  } else if (postgresDb) {
    await migratePostgres(postgresDb, { migrationsFolder })
  }
}
