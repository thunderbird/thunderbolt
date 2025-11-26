import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required but not set')
}

export const db =
  process.env.DATABASE_DRIVER === 'postgres'
    ? drizzlePostgres({ client: postgres(databaseUrl), schema })
    : drizzlePglite({ client: new PGlite(databaseUrl), schema })
