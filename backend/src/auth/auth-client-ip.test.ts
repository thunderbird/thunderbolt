/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { session } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createAuth } from './auth'

describe('Better Auth client address behind a fixed proxy chain', () => {
  const envKeys = ['AUTH_ALLOW_ANONYMOUS', 'TRUSTED_PROXY'] as const
  let savedEnv: Partial<Record<string, string>>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
    process.env.AUTH_ALLOW_ANONYMOUS = 'true'
    process.env.TRUSTED_PROXY = '1'
    clearSettingsCache()
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    clearSettingsCache()
  })

  // Better Auth exposes one request handler under both names, so a session created through
  // either must carry the proxy's hop rather than anything the client sent.
  it.each(['handler', 'fetch'] as const)(
    'records the trusted hop for a sign-in through auth.%s',
    async (entryPoint) => {
      const auth = createAuth(db)
      const response = await auth[entryPoint](
        new Request('http://localhost:8000/v1/api/auth/sign-in/anonymous', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '198.51.100.9, 203.0.113.7',
            'x-thunderbolt-client-ip': '192.0.2.66',
          },
          body: '{}',
        }),
      )
      expect(response.status).toBe(200)
      const { user } = (await response.json()) as { user: { id: string } }
      const [created] = await db.select().from(session).where(eq(session.userId, user.id))
      expect(created?.ipAddress).toBe('203.0.113.7')
    },
  )
})
