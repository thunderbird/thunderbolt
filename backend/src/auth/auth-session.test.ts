/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import * as schema from '@/db/schema'
import { session, user } from '@/db/auth-schema'
import { betterAuthTestSecret, signTestToken } from '@/test-utils/auth-token'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { createAuth } from './auth'

describe('authoritative session lookup', () => {
  const queries: string[] = []
  let db: ReturnType<typeof drizzle<typeof schema>>
  let auth: ReturnType<typeof createAuth>
  let settingsSpy: ReturnType<typeof spyOn<typeof settingsModule, 'getSettings'>>

  beforeAll(async () => {
    const { client } = await getSharedIsolatedTestDb()
    db = drizzle({ client, schema, logger: { logQuery: (query) => queries.push(query) } })
  }, 60_000)

  beforeEach(() => {
    settingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      createTestSettings({ betterAuthSecret: betterAuthTestSecret, posthogHost: '' }),
    )
    auth = createAuth(db)
  })

  afterEach(() => settingsSpy.mockRestore())

  /** Seed a fresh session with the same signed credential accepted by cookies and bearer auth. */
  const seedSession = async () => {
    const userId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const deviceId = crypto.randomUUID()
    const token = crypto.randomUUID()
    await db.insert(user).values({
      id: userId,
      email: `${userId}@example.com`,
      name: 'Session owner',
      emailVerified: true,
      isNew: false,
      isAnonymous: true,
    })
    await db.insert(session).values({
      id: sessionId,
      userId,
      deviceId,
      token,
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    return { userId, sessionId, deviceId, token: signTestToken(token) }
  }

  for (const transport of ['cookie', 'bearer'] as const) {
    const headersFor = (token: string) =>
      new Headers(
        transport === 'cookie'
          ? { cookie: `better-auth.session_token=${encodeURIComponent(token)}` }
          : { authorization: `Bearer ${token}` },
      )

    it(`loads the session and its current user in one query with ${transport} auth`, async () => {
      const seeded = await seedSession()
      const headers = headersFor(seeded.token)
      queries.length = 0

      const result = await auth.api.getSession({ headers })

      expect(result?.user).toMatchObject({
        id: seeded.userId,
        name: 'Session owner',
        emailVerified: true,
        isNew: false,
        isAnonymous: true,
      })
      expect(result?.session).toMatchObject({ id: seeded.sessionId, deviceId: seeded.deviceId })
      expect(result?.session.expiresAt).toBeInstanceOf(Date)
      expect(queries).toHaveLength(1)

      // A second request must see changed account data, not a cached joined result.
      await db.update(user).set({ name: 'Updated owner', isAnonymous: false }).where(eq(user.id, seeded.userId))
      queries.length = 0
      const refreshed = await auth.api.getSession({ headers })
      expect(refreshed?.user).toMatchObject({ name: 'Updated owner', isAnonymous: false })
      expect(queries).toHaveLength(1)
    })

    it(`rejects a session as soon as it expires with ${transport} auth`, async () => {
      const seeded = await seedSession()
      const headers = headersFor(seeded.token)
      expect((await auth.api.getSession({ headers }))?.user.id).toBe(seeded.userId)

      await db
        .update(session)
        .set({ expiresAt: new Date(0) })
        .where(eq(session.id, seeded.sessionId))

      expect(await auth.api.getSession({ headers })).toBeNull()
    })

    it(`rejects a revoked session with ${transport} auth`, async () => {
      const seeded = await seedSession()
      const headers = headersFor(seeded.token)
      expect((await auth.api.getSession({ headers }))?.user.id).toBe(seeded.userId)

      await db.delete(session).where(eq(session.id, seeded.sessionId))

      expect(await auth.api.getSession({ headers })).toBeNull()
    })

    it(`rejects a deleted account with ${transport} auth`, async () => {
      const seeded = await seedSession()
      const headers = headersFor(seeded.token)
      expect((await auth.api.getSession({ headers }))?.user.id).toBe(seeded.userId)

      await db.delete(user).where(eq(user.id, seeded.userId))

      expect(await auth.api.getSession({ headers })).toBeNull()
    })
  }
})
