/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import * as schema from '@/db/schema'
import { ensureImplicitOrganization } from '@/identity/organization'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'path'
import postgres from 'postgres'

/**
 * A real Postgres server for suites PGlite can't stand in for: PGlite runs one query at a time,
 * so it never shows what concurrent transactions do. Unset locally unless you start one; CI sets
 * it. Suites that need it skip without it: `describe.skipIf(!postgresTestUrl)`.
 */
export const postgresTestUrl = process.env.TEST_POSTGRES_URL

/**
 * A fresh, migrated database on `TEST_POSTGRES_URL`, created for one suite. `close()` drops it, so
 * suites and `--rerun-each` passes never share rows.
 */
export const createPostgresTestDb = async () => {
  if (!postgresTestUrl) {
    throw new Error('TEST_POSTGRES_URL is not set')
  }
  const name = `test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = postgres(postgresTestUrl, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database "${name}"`)
  const url = new URL(postgresTestUrl)
  url.pathname = `/${name}`
  const client = postgres(url.toString(), { onnotice: () => {} })
  const db = drizzle({ client, schema }) as unknown as typeof DbType
  await migrate(db as unknown as Parameters<typeof migrate>[0], {
    migrationsFolder: resolve(import.meta.dir, '../../drizzle'),
  })
  await ensureImplicitOrganization(db)
  return {
    db,
    close: async () => {
      await client.end()
      await admin.unsafe(`drop database "${name}" with (force)`)
      await admin.end()
    },
  }
}
