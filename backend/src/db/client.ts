import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
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

export const db = pgliteDb ?? drizzlePostgres({ client: postgres(process.env.DATABASE_URL!), schema })

/**
 * Run Drizzle migrations on PGLite databases.
 * PGLite (especially in-memory) starts with an empty schema, so migrations
 * must be applied before the server can handle requests.
 */
export const runMigrations = async () => {
  if (!pgliteDb) return
  const migrationsFolder = resolve(import.meta.dir, '../../drizzle')
  await migrate(pgliteDb, { migrationsFolder })
}
