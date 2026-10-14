/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { cliRegistrationPendingDeviceId } from '@/dal/sessions'
import { clearSettingsCache } from '@/config/settings'
import { passkey as passkeyTable, session as sessionTable, user as userTable } from '@/db/auth-schema'
import { encryptionMetadataTable } from '@/db/encryption-schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'
const authUrl = 'http://localhost:8000/v1/api/auth'

const signToken = (token: string): string =>
  `${token}.${createHmac('sha256', betterAuthSecret).update(token).digest('base64')}`

// The passkey plugin is operator-gated; enable it for this file.
let savedPasskeyEnabled: string | undefined
beforeAll(() => {
  savedPasskeyEnabled = process.env.PASSKEY_ENABLED
  process.env.PASSKEY_ENABLED = 'true'
  clearSettingsCache()
})
afterAll(() => {
  if (savedPasskeyEnabled === undefined) {
    delete process.env.PASSKEY_ENABLED
  } else {
    process.env.PASSKEY_ENABLED = savedPasskeyEnabled
  }
  clearSettingsCache()
})

describe('passkey rules (one per account, slot-safe delete)', () => {
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let userId: string
  let token: string

  const authed = (path: string, init: RequestInit = {}, extraHeaders: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${authUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${signToken(token)}`,
          ...extraHeaders,
        },
      }),
    )

  const insertPasskey = (credentialId: string) =>
    db.insert(passkeyTable).values({
      id: `pk-${userId}`,
      userId,
      publicKey: 'pk',
      credentialID: credentialId,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    })

  const insertMetadataWithSlot = (credentialId: string) =>
    db.insert(encryptionMetadataTable).values({
      userId,
      canaryIv: 'iv',
      canaryCtext: 'ctext',
      passkeyCredentialId: credentialId,
      passkeyEcdhPublicKey: 'ecdh',
      passkeyMlkemPublicKey: 'mlkem',
      passkeyWrappedAk: 'wrapped',
      passkeyAttestation: 'att',
      schemeVersion: 2,
    })

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    auth = createAuth(db)
    userId = `passkey-user-${crypto.randomUUID()}`
    token = `passkey-token-${crypto.randomUUID()}`
    const now = new Date()
    await db.insert(userTable).values({
      id: userId,
      name: 'Passkey User',
      email: `${userId}@test.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(sessionTable).values({
      id: `session-${userId}`,
      token,
      userId,
      expiresAt: new Date(now.getTime() + 3600 * 1000),
      createdAt: now,
      updatedAt: now,
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('lets an account without a passkey start registration', async () => {
    const res = await authed('/passkey/generate-register-options')
    expect(res.status).toBe(200)
  })

  // The user before-hook runs ahead of the bearer plugin; a bearer-only caller
  // must still be recognised, or these rules silently do nothing.
  it('refuses passkey registration for an anonymous user calling with a bearer token', async () => {
    await db.update(userTable).set({ isAnonymous: true }).where(eq(userTable.id, userId))
    const res = await authed('/passkey/generate-register-options')
    expect(res.status).toBe(403)
  })

  it.each(['cli-0b6e2c4a-1f3d-4c8e-9a7b-2d5f6e8a9c01', cliRegistrationPendingDeviceId])(
    'refuses passkey management from a CLI device-grant session (%s)',
    async (deviceId) => {
      await db.update(sessionTable).set({ deviceId }).where(eq(sessionTable.userId, userId))
      const res = await authed('/passkey/generate-register-options')
      expect(res.status).toBe(403)
    },
  )

  // Better Auth requires a recent sign-in to add a passkey. The client keys its
  // "confirm it's you" step on this code.
  it('refuses registration from a session older than a day with SESSION_NOT_FRESH', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    await db.update(sessionTable).set({ createdAt: twoDaysAgo }).where(eq(sessionTable.userId, userId))
    const res = await authed('/passkey/generate-register-options')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('SESSION_NOT_FRESH')
  })

  it('refuses a second passkey', async () => {
    await insertPasskey(`cred-${userId}`)
    const res = await authed('/passkey/generate-register-options')
    expect(res.status).toBe(409)
  })

  // The registration ceremony can be posted without going through generate-options.
  it('refuses a second passkey at verify-registration too', async () => {
    await insertPasskey(`cred-${userId}`)
    const res = await authed('/passkey/verify-registration', { method: 'POST', body: JSON.stringify({ response: {} }) })
    expect(res.status).toBe(409)
  })

  it('refuses passkey management from an API-key session', async () => {
    const created = await authed('/api-key/create', { method: 'POST', body: '{}' })
    expect(created.status).toBe(200)
    const { key } = (await created.json()) as { key: string }

    const res = await auth.handler(
      new Request(`${authUrl}/passkey/generate-register-options`, { headers: { 'x-api-key': key } }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).message).toBe('Passkeys need an interactive session')
  })

  it('serves no passkey routes when passkeys are off', async () => {
    process.env.PASSKEY_ENABLED = 'false'
    clearSettingsCache()
    try {
      auth = createAuth(db)
      const res = await authed('/passkey/generate-register-options')
      expect(res.status).toBe(404)
    } finally {
      process.env.PASSKEY_ENABLED = 'true'
      clearSettingsCache()
    }
  })

  it('refuses to delete the passkey while it holds the sync slot', async () => {
    await insertPasskey(`cred-${userId}`)
    await insertMetadataWithSlot(`cred-${userId}`)

    const res = await authed('/passkey/delete-passkey', {
      method: 'POST',
      body: JSON.stringify({ id: `pk-${userId}` }),
    })
    expect(res.status).toBe(409)
    expect(await db.select().from(passkeyTable).where(eq(passkeyTable.userId, userId))).toHaveLength(1)
  })

  it('deletes a passkey that holds no sync slot', async () => {
    await insertPasskey(`cred-${userId}`)

    const res = await authed('/passkey/delete-passkey', {
      method: 'POST',
      body: JSON.stringify({ id: `pk-${userId}` }),
    })
    expect(res.status).toBe(200)
    expect(await db.select().from(passkeyTable).where(eq(passkeyTable.userId, userId))).toHaveLength(0)
  })
})
