/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import * as schema from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { scim } from '@better-auth/scim'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { identity } from './plugin'

/**
 * Better Auth checks, on every `auth.api` call, that the Drizzle schema has every column its
 * models write. This pins `identity()` and the SCIM plugin's tables (installed here only to check
 * them) against `@/db/schema`.
 */
describe('identity and SCIM schema', () => {
  let db: typeof DbType
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ db, cleanup } = await createTestDb())
  })

  afterEach(async () => {
    await cleanup()
  })

  const authWith = (drizzleSchema: Record<string, unknown>) =>
    betterAuth({
      secret: 'better-auth-secret-12345678901234567890',
      baseURL: 'http://localhost:8000',
      database: drizzleAdapter(db, { provider: 'pg', schema: drizzleSchema, transaction: true }),
      plugins: [identity(), scim({ connections: [], managedConnections: { credentialHashSecret: 'x'.repeat(48) } })],
    })

  it('matches what the identity and SCIM plugins write', async () => {
    expect(await authWith(schema).api.getSession({ headers: new Headers() })).toBeNull()
  })

  it('fails when a table they write is missing', async () => {
    const { membershipSource: _, ...withoutTable } = schema
    await expect(authWith(withoutTable).api.getSession({ headers: new Headers() })).rejects.toThrow(/membershipSource/)
  })
})
