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
  : process.env.DATABASE_URL || (isDevelopment ? 'postgresql://postgres:postgres@localhost:5433/postgres' : '')

// When DRIVER=pglite, `DATABASE_URL` is treated as a *data-directory path*
// (`.env.example` documents `.pglite/data`). The default dev / e2e `.env`
// ships `postgresql://...` for the postgres driver, though, and inherits
// into pglite-mode runs (bun test, playwright web-server, manual `bun run
// src/index.ts` with mixed env). `new PGlite('postgresql://...')` then
// treats the connection string as a path and bootstraps a real Postgres
// data dir into `backend/postgresql:/postgres:postgres@localhost:.../...`.
// Detect the schema and treat connection-string values as "no path given"
// (i.e. in-memory PGlite).
const isPostgresConnectionUrl = (url: string | undefined): boolean =>
  typeof url === 'string' && /^(?:postgres|postgresql):\/\//.test(url)

const pgliteDataDir =
  isPglite && process.env.DATABASE_URL && !isPostgresConnectionUrl(process.env.DATABASE_URL)
    ? process.env.DATABASE_URL
    : undefined

/**
 * Return `scheme://host[:port]` from a DB connection string, dropping any
 * embedded userinfo. Falls back to `<unparseable>` so we never leak the raw
 * value on a malformed URL — connection strings can carry credentials
 * (`postgres://user:password@host/db`) and logs travel further than we expect.
 */
const redactDatabaseUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '<unparseable>'
  }
}

if (isPglite && process.env.DATABASE_URL && isPostgresConnectionUrl(process.env.DATABASE_URL)) {
  console.warn(
    `[db] DATABASE_DRIVER=pglite but DATABASE_URL is a postgres connection string ` +
      `(${redactDatabaseUrl(process.env.DATABASE_URL)}) — falling back to in-memory PGlite. ` +
      `Set DATABASE_URL to a directory path (e.g. .pglite/data) if you meant to persist.`,
  )
}

if (pgliteDataDir) {
  mkdirSync(resolve(pgliteDataDir), { recursive: true })
}

const pgliteClient = isPglite
  ? pgliteDataDir
    ? new PGlite(pgliteDataDir)
    : new PGlite() // no dataDir → in-memory
  : null

const pgliteDb = pgliteClient ? drizzlePglite({ client: pgliteClient, schema }) : null

const postgresDb = postgresUrl
  ? drizzlePostgres({ client: postgres(postgresUrl, { onnotice: () => {} }), schema })
  : null

export const db = pgliteDb ?? postgresDb!

/** Query-builder surface shared by root databases and transaction clients. */
export type QueryableDatabase = Pick<typeof db, 'delete' | 'insert' | 'select' | 'update'>

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
