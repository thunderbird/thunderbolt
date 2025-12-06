import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// For postgres driver, DATABASE_URL is required
if (process.env.DATABASE_DRIVER === 'postgres' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required when DATABASE_DRIVER=postgres')
}

export const db =
  process.env.DATABASE_DRIVER === 'postgres'
    ? drizzlePostgres({ client: postgres(process.env.DATABASE_URL!), schema })
    : drizzlePglite({ client: new PGlite(process.env.DATABASE_URL), schema }) // undefined = in-memory
