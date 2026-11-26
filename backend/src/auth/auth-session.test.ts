/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as settingsModule from '@/config/settings'
import * as schema from '@/db/schema'
import { session, user } from '@/db/auth-schema'
import { betterAuthTestSecret, signTestToken } from '@/test-utils/auth-token'
import { getSharedIsolatedTestDb, type IsolatedTestDb } from '@/test-utils/db'
import { createAuthDouble } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { createAuth } from './auth'
import { createWsSessionGuard, wsCloseAuthUnavailable, wsCloseUnauthorized } from './ws-bearer-auth'
import { encodeWsBearer } from '@shared/ws-bearer'

describe('authoritative session lookup', () => {
  const queries: string[] = []
  let client: IsolatedTestDb['client']
  let db: ReturnType<typeof drizzle<typeof schema>>
  let auth: ReturnType<typeof createAuth>
  let settingsSpy: ReturnType<typeof spyOn<typeof settingsModule, 'getSettings'>>

  beforeAll(async () => {
    client = (await getSharedIsolatedTestDb()).client
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

  it('rechecks a live bearer against the database after revocation', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const closes: number[] = []
    const guard = createWsSessionGuard(auth, `thunderbolt.bearer.${encodeWsBearer(seeded.token)}`, (code) =>
      closes.push(code),
    )
    try {
      expect(await guard.check()).toBe(true)
      await db.delete(session).where(eq(session.id, seeded.sessionId))
      await Bun.sleep(1_010)
      expect(await guard.check()).toBe(false)
      expect(closes).toEqual([wsCloseUnauthorized])
    } finally {
      guard.stop()
    }
  })

  it('does not extend a session when a live socket checks near the refresh threshold', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await db.update(session).set({ expiresAt }).where(eq(session.id, seeded.sessionId))
    const guard = createWsSessionGuard(auth, `thunderbolt.bearer.${encodeWsBearer(seeded.token)}`, () => {})
    try {
      expect(await guard.check()).toBe(true)
      expect(await guard.check()).toBe(true)
      const [stored] = await db
        .select({ expiresAt: session.expiresAt })
        .from(session)
        .where(eq(session.id, seeded.sessionId))
      expect(stored.expiresAt).toEqual(expiresAt)
    } finally {
      guard.stop()
    }
  })

  it('reads each handshake freshly while sharing frame validation across sockets with one bearer', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const header = `thunderbolt.bearer.${encodeWsBearer(seeded.token)}`
    const first = createWsSessionGuard(auth, header, () => {})
    const second = createWsSessionGuard(auth, header, () => {})
    try {
      queries.length = 0
      const opened = await Promise.all([first.authorize(), second.authorize()])
      expect(opened.map((result) => result.ok)).toEqual([true, true])
      expect(queries).toHaveLength(2)
      expect(
        (await Promise.all(Array.from({ length: 100 }, (_, index) => (index % 2 ? first : second).check()))).every(
          Boolean,
        ),
      ).toBe(true)
      expect(queries).toHaveLength(2)
    } finally {
      first.stop()
      second.stop()
    }
  })

  it('rejects a new handshake immediately after revocation and closes the existing socket', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const header = `thunderbolt.bearer.${encodeWsBearer(seeded.token)}`
    const closes: number[] = []
    const first = createWsSessionGuard(auth, header, (code) => closes.push(code))
    const second = createWsSessionGuard(auth, header, () => {})
    try {
      expect(await first.authorize()).toMatchObject({ ok: true })
      await db.delete(session).where(eq(session.id, seeded.sessionId))
      expect(await second.authorize()).toMatchObject({ ok: false, closeCode: wsCloseUnauthorized })
      expect(closes).toEqual([wsCloseUnauthorized])
    } finally {
      first.stop()
      second.stop()
    }
  })

  it('does not inherit a session read that began before revocation or revive a denied group', async () => {
    const gate = Promise.withResolvers<void>()
    const calls: number[] = []
    let revoked = false
    const fakeAuth = createAuthDouble(async () => {
      calls.push(Date.now())
      if (calls.length === 2) {
        await gate.promise
        return { user: { id: 'test-user', isAnonymous: false }, session: {} }
      }
      return revoked ? null : { user: { id: 'test-user', isAnonymous: false }, session: {} }
    })
    const header = `thunderbolt.bearer.${encodeWsBearer('test-token')}`
    const closes: number[] = []
    const first = createWsSessionGuard(fakeAuth, header, (code) => closes.push(code))
    try {
      expect(await first.authorize()).toMatchObject({ ok: true })
      await Bun.sleep(1_010)
      const pendingFrame = first.check()
      revoked = true
      const second = createWsSessionGuard(fakeAuth, header, () => {})
      try {
        const handshake = second.authorize()
        await Promise.resolve()
        expect(calls).toHaveLength(3) // The new handshake started its own read while the old one is pending.
        expect(await handshake).toMatchObject({ ok: false, closeCode: wsCloseUnauthorized })
        gate.resolve()
        expect(await pendingFrame).toBe(false)
        expect(closes).toEqual([wsCloseUnauthorized])
        expect(calls).toHaveLength(3)
      } finally {
        second.stop()
      }
    } finally {
      gate.resolve()
      first.stop()
    }
  })

  it('forces a fresh poll after cached success, closes both sockets, and leaves another bearer live', async () => {
    const revoked = await seedSession()
    const live = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, revoked.userId))
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, live.userId))
    const header = `thunderbolt.bearer.${encodeWsBearer(revoked.token)}`
    const closes: number[] = []
    const first = createWsSessionGuard(auth, header, (code) => closes.push(code))
    const second = createWsSessionGuard(auth, header, (code) => closes.push(code))
    const other = createWsSessionGuard(auth, `thunderbolt.bearer.${encodeWsBearer(live.token)}`, () => {})
    try {
      expect(await first.authorize()).toMatchObject({ ok: true })
      expect(await second.authorize()).toMatchObject({ ok: true })
      expect(await other.authorize()).toMatchObject({ ok: true })
      await Bun.sleep(4_200)
      expect(await first.check()).toBe(true) // Refresh the one-second cache just before the timer tick.
      await db.delete(session).where(eq(session.id, revoked.sessionId))
      expect(await first.check()).toBe(true) // The short success window is intentional.
      const deadline = Date.now() + 11_000
      while (closes.length < 2 && Date.now() < deadline) {
        await Bun.sleep(50)
      }
      expect(closes).toEqual([wsCloseUnauthorized, wsCloseUnauthorized])
      expect(await other.check()).toBe(true)
    } finally {
      first.stop()
      second.stop()
      other.stop()
    }
  }, 16_000)

  it('polls again when an inbound lookup was already in flight at the timer tick', async () => {
    const gate = Promise.withResolvers<void>()
    const calls: number[] = []
    let revoked = false
    const fakeAuth = createAuthDouble(async () => {
      calls.push(Date.now())
      if (calls.length === 2) {
        await gate.promise
        return { user: { id: 'test-user', isAnonymous: false }, session: {} }
      }
      return revoked ? null : { user: { id: 'test-user', isAnonymous: false }, session: {} }
    })
    const closes: number[] = []
    const guard = createWsSessionGuard(fakeAuth, `thunderbolt.bearer.${encodeWsBearer('test-token')}`, (code) =>
      closes.push(code),
    )
    try {
      expect(await guard.authorize()).toMatchObject({ ok: true })
      await Bun.sleep(4_200)
      const frameCheck = guard.check()
      await Bun.sleep(1_300)
      revoked = true
      gate.resolve()
      await frameCheck
      const deadline = Date.now() + 6_000
      while (closes.length === 0 && Date.now() < deadline) {
        await Bun.sleep(50)
      }
      expect(calls).toHaveLength(3)
      expect(closes).toEqual([wsCloseUnauthorized])
    } finally {
      gate.resolve()
      guard.stop()
    }
  }, 13_000)

  it('removes the last socket guard so a later socket cannot reuse its cached result', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const header = `thunderbolt.bearer.${encodeWsBearer(seeded.token)}`
    const first = createWsSessionGuard(auth, header, () => {})
    expect(await first.authorize()).toMatchObject({ ok: true })
    first.stop()
    await db.delete(session).where(eq(session.id, seeded.sessionId))
    const later = createWsSessionGuard(auth, header, () => {})
    try {
      expect(await later.authorize()).toMatchObject({ ok: false, closeCode: wsCloseUnauthorized })
    } finally {
      later.stop()
    }
    queries.length = 0
    await Bun.sleep(5_100)
    expect(queries).toHaveLength(0) // Neither stopped guard keeps polling.
  }, 10_000)

  it('keeps live sockets open when a new handshake cannot reach the database', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const header = `thunderbolt.bearer.${encodeWsBearer(seeded.token)}`
    const closes: number[] = []
    const first = createWsSessionGuard(auth, header, (code) => closes.push(code))
    const second = createWsSessionGuard(auth, header, (code) => closes.push(code))
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {})
    const querySpy = spyOn(client, 'query')
    try {
      expect(await first.authorize()).toMatchObject({ ok: true })
      querySpy.mockRejectedValueOnce(new Error('connection refused'))
      expect(await second.authorize()).toMatchObject({ ok: false, closeCode: wsCloseAuthUnavailable })
      expect(closes).toEqual([])
      expect(await first.check()).toBe(true)
    } finally {
      querySpy.mockRestore()
      consoleSpy.mockRestore()
      first.stop()
      second.stop()
    }
  })

  it('keeps the last result while a session read fails, then still closes on revocation', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const closes: number[] = []
    const guard = createWsSessionGuard(auth, `thunderbolt.bearer.${encodeWsBearer(seeded.token)}`, (code) =>
      closes.push(code),
    )
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {})
    const querySpy = spyOn(client, 'query')
    try {
      expect(await guard.authorize()).toMatchObject({ ok: true })
      await Bun.sleep(1_010)
      querySpy.mockRejectedValueOnce(new Error('connection refused'))
      expect(await guard.check()).toBe(true)
      expect(closes).toEqual([])
      await db.delete(session).where(eq(session.id, seeded.sessionId))
      await Bun.sleep(1_010)
      expect(await guard.check()).toBe(false)
      expect(closes).toEqual([wsCloseUnauthorized])
    } finally {
      querySpy.mockRestore()
      consoleSpy.mockRestore()
      guard.stop()
    }
  })

  it('shares one group across the encodings Better Auth accepts for the same bearer', async () => {
    const seeded = await seedSession()
    await db.update(user).set({ isAnonymous: false }).where(eq(user.id, seeded.userId))
    const headerFor = (token: string) => `thunderbolt.bearer.${encodeWsBearer(token)}`
    const percentEncodedFirstChar = `%${seeded.token.charCodeAt(0).toString(16)}${seeded.token.slice(1)}`
    const first = createWsSessionGuard(auth, headerFor(seeded.token), () => {})
    const variants = [` ${seeded.token}`, `\t${seeded.token}`, `${seeded.token} `, percentEncodedFirstChar].map(
      (token) => createWsSessionGuard(auth, headerFor(token), () => {}),
    )
    try {
      expect(await first.authorize()).toMatchObject({ ok: true })
      queries.length = 0
      expect(await Promise.all(variants.map((guard) => guard.check()))).toEqual([true, true, true, true])
      expect(queries).toHaveLength(0) // Every variant reuses the first socket's group instead of polling on its own.
    } finally {
      first.stop()
      for (const guard of variants) {
        guard.stop()
      }
    }
  })

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
