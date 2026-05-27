/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import postgres from 'postgres'
import * as schema from './schema'

// Default driver is postgres pointing at the local Docker stack (powersync-service/).
// PGlite is opt-in via DATABASE_DRIVER=pglite for backend-only work without Docker;
// note that PowerSync cannot replicate from PGlite.
const isDevelopment = process.env.NODE_ENV === 'development'
const isPglite = process.env.DATABASE_DRIVER === 'pglite'

if (!isPglite && !process.env.DATABASE_URL && !isDevelopment) {
  throw new Error('DATABASE_URL is required when DATABASE_DRIVER=postgres (outside development)')
}

const postgresUrl = isPglite
  ? null
  : process.env.DATABASE_URL ||
    (isDevelopment ? 'postgresql://postgres:postgres@localhost:5433/postgres' : '')

if (isPglite && process.env.DATABASE_URL) {
  mkdirSync(resolve(process.env.DATABASE_URL), { recursive: true })
}

const pgliteClient = isPglite ? new PGlite(process.env.DATABASE_URL) : null // undefined = in-memory

const pgliteDb = pgliteClient ? drizzlePglite({ client: pgliteClient, schema }) : null

const postgresDb = postgresUrl
  ? drizzlePostgres({ client: postgres(postgresUrl, { onnotice: () => {} }), schema })
  : null

export const db = pgliteDb ?? postgresDb!

/** Close the database connection — call this during test teardown to release WASM resources */
export const closeDb = async () => {
  if (pgliteClient && !pgliteClient.closed) {
    await pgliteClient.close()
  }
}

/**
 * Resolve the Drizzle migrations folder.
 * Override with MIGRATIONS_DIR env var; defaults to `<cwd>/drizzle`.
 *
 * Uses process.cwd() instead of import.meta.dir because compiled Bun binaries
 * resolve import.meta.dir to the executable's directory, not the source file's.
 * The Docker WORKDIR is set to /app/backend, so the default resolves correctly.
 */
export const getMigrationsFolder = () => process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'drizzle')

/**
 * Run Drizzle migrations on startup.
 * Disable with SKIP_MIGRATIONS=true (e.g. when migrations are handled externally).
 */
export const runMigrations = async () => {
  if (process.env.SKIP_MIGRATIONS === 'true') {
    return
  }
  const migrationsFolder = getMigrationsFolder()
  if (pgliteDb) {
    await migratePglite(pgliteDb, { migrationsFolder })
  } else if (postgresDb) {
    await migratePostgres(postgresDb, { migrationsFolder })
  }
}
