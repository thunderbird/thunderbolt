import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from './schema'

const client = new PGlite(process.env.DATABASE_URL!)
export const db = drizzle({ client, schema })
