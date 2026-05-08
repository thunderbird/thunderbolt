/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { devicesTable, mcpServersTable, modelsTable, promptsTable, settingsTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createPowerSyncRoutes } from './powersync'

/** Better Auth uses this default secret in test environments */
const betterAuthSecret = 'better-auth-secret-12345678901234567890'

/** Sign a raw session token for use in `Authorization: Bearer <signed>` headers (standard base64 to match getSignedCookie expectations) */
const signToken = (token: string): string => {
  const sig = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${sig}`
}

const powersyncSettings: Settings = {
  fireworksApiKey: '',
  mistralApiKey: '',
  anthropicApiKey: '',
  exaApiKey: '',
  thunderboltInferenceUrl: '',
  thunderboltInferenceApiKey: '',
  monitoringToken: '',
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  microsoftClientSecret: '',
  logLevel: 'INFO',
  port: 8000,
  appUrl: 'http://localhost:1420',
  posthogHost: '',
  posthogApiKey: '',
  corsOrigins: '',
  corsAllowCredentials: true,
  corsAllowMethods: '',
  corsAllowHeaders: '',
  corsExposeHeaders: '',
  waitlistEnabled: false,
  waitlistAutoApproveDomains: '',
  powersyncUrl: 'https://powersync.example.com',
  powersyncJwtKid: 'test-kid',
  powersyncJwtSecret: 'test-jwt-secret-min-32-chars-long',
  powersyncTokenExpirySeconds: 3600,
  authMode: 'consumer' as const,
  oidcClientId: '',
  oidcClientSecret: '',
  oidcIssuer: '',
  oidcDiscoveryUrl: '',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret,
  e2eeEnabled: true,
  rateLimitEnabled: false,
  swaggerEnabled: false,
  trustedProxy: '',
  samlEntryPoint: '',
  samlEntityId: '',
  samlIdpIssuer: '',
  samlCert: '',
}

describe('PowerSync API', () => {
  let app: Elysia
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const { auth } = createBetterAuthPlugin(db)
    app = new Elysia().use(createPowerSyncRoutes(auth, powersyncSettings, db)) as unknown as Elysia
  })

  afterEach(async () => {
    await cleanup()
  })

  const uploadHeaders = (bearer: string, deviceId = 'test-device-id') => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${signToken(bearer)}`,
    'X-Device-ID': deviceId,
  })

  /** Insert a trusted device so it passes validateDeviceForSync. */
  const insertTrustedDevice = async (deviceId: string, userId: string) => {
    const now = new Date()
    await db.insert(devicesTable).values({
      id: deviceId,
      userId,
      name: 'Test Device',
      trusted: true,
      lastSeen: now,
      createdAt: now,
    })
  }

  describe('GET /powersync/token', () => {
    it('returns 401 when no session and no Bearer token', async () => {
      const response = await app.handle(new Request('http://localhost/powersync/token'))
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data).toEqual({ error: 'Unauthorized' })
    })

    it('returns 401 when Bearer token does not match any session', async () => {
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: { Authorization: `Bearer ${signToken('invalid-token')}` },
        }),
      )
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data).toEqual({ error: 'Unauthorized' })
    })

    it('returns 401 when Bearer token is unsigned (requireSignature enforcement)', async () => {
      const userId = 'user-unsigned-bearer'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Unsigned Bearer User',
        email: 'unsigned-bearer@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-unsigned-bearer',
        expiresAt,
        token: 'bearer-unsigned-valid',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      // Token exists in DB but is sent unsigned — must be rejected
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: 'Bearer bearer-unsigned-valid',
            'x-device-id': 'some-device',
          },
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 403 when device is revoked', async () => {
      const userId = 'user-revoked-device'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Revoked Device User',
        email: 'revoked-powersync@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-revoked',
        expiresAt,
        token: 'bearer-revoked-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const revokedAt = new Date()
      await db.insert(devicesTable).values({
        id: 'revoked-device-id',
        userId,
        name: 'Revoked Device',
        lastSeen: new Date(revokedAt.getTime() - 60 * 1000),
        createdAt: new Date(revokedAt.getTime() - 120 * 1000),
        revokedAt,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-revoked-device')}`,
            'x-device-id': 'revoked-device-id',
          },
        }),
      )
      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_DISCONNECTED' })
    })

    it('returns 409 when device id belongs to another user', async () => {
      const userA = 'user-a-device-owner'
      const userB = 'user-b-collision'
      const sharedDeviceId = 'shared-device-id'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values([
        { id: userA, name: 'User A', email: 'user-a@example.com', emailVerified: true, createdAt: now, updatedAt: now },
        { id: userB, name: 'User B', email: 'user-b@example.com', emailVerified: true, createdAt: now, updatedAt: now },
      ])

      await db.insert(sessionTable).values({
        id: 'session-user-b',
        expiresAt,
        token: 'bearer-user-b',
        createdAt: now,
        updatedAt: now,
        userId: userB,
      })

      await db.insert(devicesTable).values({
        id: sharedDeviceId,
        userId: userA,
        name: "User A's Device",
        lastSeen: now,
        createdAt: now,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-user-b')}`,
            'x-device-id': sharedDeviceId,
          },
        }),
      )
      expect(response.status).toBe(409)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_ID_TAKEN' })
    })

    it('returns 403 when device does not exist in the database', async () => {
      const userId = 'user-nonexistent-device'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Nonexistent Device User',
        email: 'nonexistent-device@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-nonexistent-device',
        expiresAt,
        token: 'bearer-nonexistent-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-nonexistent-device')}`,
            'x-device-id': 'device-that-does-not-exist',
          },
        }),
      )
      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_NOT_TRUSTED' })
    })

    it('returns 403 when device is untrusted (pending approval)', async () => {
      const userId = 'user-untrusted-device'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Untrusted Device User',
        email: 'untrusted-device@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-untrusted-device',
        expiresAt,
        token: 'bearer-untrusted-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(devicesTable).values({
        id: 'untrusted-device-id',
        userId,
        name: 'Pending Device',
        trusted: false,
        lastSeen: now,
        createdAt: now,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-untrusted-device')}`,
            'x-device-id': 'untrusted-device-id',
          },
        }),
      )
      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_NOT_TRUSTED' })
    })

    it('returns 400 when x-device-id is missing', async () => {
      const userId = 'user-no-device-id'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'No Device ID User',
        email: 'no-device-id@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-no-device-id',
        expiresAt,
        token: 'bearer-no-device-id',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: { Authorization: `Bearer ${signToken('bearer-no-device-id')}` },
        }),
      )
      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_ID_REQUIRED' })
    })

    it('returns 400 when x-device-id is empty', async () => {
      const userId = 'user-empty-device-id'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Empty Device ID User',
        email: 'empty-device-id@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-empty-device-id',
        expiresAt,
        token: 'bearer-empty-device-id',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-empty-device-id')}`,
            'x-device-id': '   ',
          },
        }),
      )
      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_ID_REQUIRED' })
    })

    it('revoked device cannot bypass by omitting x-device-id', async () => {
      const userId = 'user-revoked-bypass'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Revoked Bypass User',
        email: 'revoked-bypass@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-revoked-bypass',
        expiresAt,
        token: 'bearer-revoked-bypass',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const revokedAt = new Date()
      await db.insert(devicesTable).values({
        id: 'revoked-bypass-device',
        userId,
        name: 'Revoked Device',
        lastSeen: new Date(revokedAt.getTime() - 60 * 1000),
        createdAt: new Date(revokedAt.getTime() - 120 * 1000),
        revokedAt,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: { Authorization: `Bearer ${signToken('bearer-revoked-bypass')}` },
        }),
      )
      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_ID_REQUIRED' })
    })

    it('rejects token request for unregistered device ID', async () => {
      const userId = 'user-unregistered-device'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Unregistered Device User',
        email: 'unregistered-device@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-unregistered-device',
        expiresAt,
        token: 'bearer-unregistered-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      // Device ID 'nonexistent-device' is NOT in the DB
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-unregistered-device')}`,
            'x-device-id': 'nonexistent-device',
          },
        }),
      )
      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_NOT_TRUSTED' })
    })

    it('revoked device cannot bypass by using a new unregistered device ID', async () => {
      const userId = 'user-revocation-bypass'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Revocation Bypass User',
        email: 'revocation-bypass@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-revocation-bypass',
        expiresAt,
        token: 'bearer-revocation-bypass',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      // Register and revoke a device
      const revokedAt = new Date()
      await db.insert(devicesTable).values({
        id: 'original-device',
        userId,
        name: 'Original Device',
        lastSeen: new Date(revokedAt.getTime() - 60 * 1000),
        createdAt: new Date(revokedAt.getTime() - 120 * 1000),
        revokedAt,
      })

      // Verify the revoked device is rejected
      const revokedResponse = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-revocation-bypass')}`,
            'x-device-id': 'original-device',
          },
        }),
      )
      expect(revokedResponse.status).toBe(403)
      expect(await revokedResponse.json()).toEqual({ code: 'DEVICE_DISCONNECTED' })

      // Attempt bypass: use a NEW device ID that doesn't exist in the DB
      const bypassResponse = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-revocation-bypass')}`,
            'x-device-id': 'bypass-attempt-new-device',
          },
        }),
      )
      // Must NOT succeed — unknown device IDs should be rejected
      expect(bypassResponse.status).toBe(403)
      expect(await bypassResponse.json()).toEqual({ code: 'DEVICE_NOT_TRUSTED' })
    })

    it('returns token and powerSyncUrl when authenticated via session with x-device-id', async () => {
      const userId = 'user-powersync-token'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'PowerSync User',
        email: 'powersync-token@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-powersync-token',
        expiresAt,
        token: 'bearer-powersync-valid',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('device-session-token', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-powersync-valid')}`,
            'x-device-id': 'device-session-token',
          },
        }),
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { token: string; expiresAt: string; powerSyncUrl: string }
      expect(data.token).toBeDefined()
      expect(typeof data.token).toBe('string')
      expect(data.expiresAt).toBeDefined()
      expect(data.powerSyncUrl).toBe('https://powersync.example.com')
    })

    it('updates device name when x-device-name is provided on token request', async () => {
      const userId = 'user-device-upsert'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Device User',
        email: 'device-powersync@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-device-upsert',
        expiresAt,
        token: 'bearer-device-upsert',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('device-123', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-device-upsert')}`,
            'x-device-id': 'device-123',
            'x-device-name': 'My Phone',
          },
        }),
      )
      expect(response.status).toBe(200)

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, 'device-123'))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.userId).toBe(userId)
      expect(devices[0]?.name).toBe('My Phone')
    })

    it('updates device with "Unknown device" when x-device-name is empty', async () => {
      const userId = 'user-device-no-name'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'No Name User',
        email: 'device-no-name@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-device-no-name',
        expiresAt,
        token: 'bearer-device-no-name',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('device-empty-name', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-device-no-name')}`,
            'x-device-id': 'device-empty-name',
            'x-device-name': '',
          },
        }),
      )
      expect(response.status).toBe(200)

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, 'device-empty-name'))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.name).toBe('Unknown device')
    })

    it('updates device with "Unknown device" when x-device-name exceeds 100 characters', async () => {
      const userId = 'user-device-long-name'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Long Name User',
        email: 'device-long-name@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-device-long-name',
        expiresAt,
        token: 'bearer-device-long-name',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('device-long-name', userId)

      const longName = 'a'.repeat(101)
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-device-long-name')}`,
            'x-device-id': 'device-long-name',
            'x-device-name': longName,
          },
        }),
      )
      expect(response.status).toBe(200)

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, 'device-long-name'))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.name).toBe('Unknown device')
    })

    it('updates device when x-device-name is exactly 100 characters', async () => {
      const userId = 'user-device-100-char'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: '100 Char User',
        email: 'device-100-char@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-device-100-char',
        expiresAt,
        token: 'bearer-device-100-char',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('device-100-char', userId)

      const name100 = 'a'.repeat(100)
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-device-100-char')}`,
            'x-device-id': 'device-100-char',
            'x-device-name': name100,
          },
        }),
      )
      expect(response.status).toBe(200)

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, 'device-100-char'))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.name).toBe(name100)
    })

    it('updates device when x-device-name is a single character', async () => {
      const userId = 'user-device-1-char'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: '1 Char User',
        email: 'device-1-char@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-device-1-char',
        expiresAt,
        token: 'bearer-device-1-char',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('device-1-char', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-device-1-char')}`,
            'x-device-id': 'device-1-char',
            'x-device-name': 'X',
          },
        }),
      )
      expect(response.status).toBe(200)

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, 'device-1-char'))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.name).toBe('X')
    })
  })

  describe('PUT /powersync/upload', () => {
    it('returns 401 when not authenticated', async () => {
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: [] }),
        }),
      )
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data).toEqual({ error: 'Unauthorized' })
    })

    it('returns 400 when X-Device-ID is missing', async () => {
      const userId = 'user-upload-no-device'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload User',
        email: 'upload-no-device@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-no-device',
        expiresAt,
        token: 'bearer-upload-no-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-upload-no-device')}`,
          },
          body: JSON.stringify({ operations: [] }),
        }),
      )
      expect(response.status).toBe(400)
      const data = (await response.json()) as { code: string }
      expect(data.code).toBe('DEVICE_ID_REQUIRED')
    })

    it('returns 403 when device is revoked', async () => {
      const userId = 'user-upload-revoked'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Revoked User',
        email: 'upload-revoked@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-revoked',
        expiresAt,
        token: 'bearer-upload-revoked',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(devicesTable).values({
        id: 'revoked-upload-device',
        userId,
        name: 'Revoked Device',
        lastSeen: now,
        createdAt: now,
        revokedAt: now,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-revoked', 'revoked-upload-device'),
          body: JSON.stringify({
            operations: [{ op: 'PUT' as const, type: 'settings', id: 'key', data: { value: 'x' } }],
          }),
        }),
      )
      expect(response.status).toBe(403)
      const data = (await response.json()) as { code: string }
      expect(data.code).toBe('DEVICE_DISCONNECTED')
    })

    it('rejects upload for unregistered device ID', async () => {
      const userId = 'user-upload-unregistered'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Unregistered User',
        email: 'upload-unregistered@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-unregistered',
        expiresAt,
        token: 'bearer-upload-unregistered',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      // Device 'unknown-upload-device' is NOT registered
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-unregistered', 'unknown-upload-device'),
          body: JSON.stringify({
            operations: [{ op: 'PUT' as const, type: 'settings', id: 'key', data: { value: 'x' } }],
          }),
        }),
      )
      expect(response.status).toBe(403)
      const data = (await response.json()) as { code: string }
      expect(data.code).toBe('DEVICE_NOT_TRUSTED')
    })

    it('returns 422 when body schema is invalid (operations not an array)', async () => {
      const userId = 'user-upload-validation'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload User',
        email: 'upload-validation@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-validation',
        expiresAt,
        token: 'bearer-upload-validation',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-validation'),
          body: JSON.stringify({ operations: 'not-an-array' }),
        }),
      )
      expect(response.status).toBe(422)
    })

    it('returns 200 and applies PUT operation to settings', async () => {
      const userId = 'user-upload-put'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Put User',
        email: 'upload-put@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-put',
        expiresAt,
        token: 'bearer-upload-put',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-put'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'settings',
                id: 'test_setting_key',
                data: { value: 'test_value' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { success: boolean }
      expect(data.success).toBe(true)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_setting_key'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('test_value')
      expect(rows[0]?.userId).toBe(userId)
    })

    it('ignores user_id and id in PUT payload, always uses session user', async () => {
      const userId = 'user-put-owns-row'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Owner',
        email: 'owner@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(sessionTable).values({
        id: 'session-put-owns',
        expiresAt,
        token: 'bearer-put-owns',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-put-owns'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'settings',
                id: 'owned_setting',
                data: { value: 'correct', user_id: 'other-user-id', id: 'ignored_id' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'owned_setting'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe(userId)
      expect(rows[0]?.value).toBe('correct')
      expect(rows[0]?.key).toBe('owned_setting')
    })

    it('user B cannot update or overwrite user A setting (WHERE user_id validates)', async () => {
      const userA = 'user-a-same-setting'
      const userB = 'user-b-same-setting'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values([
        { id: userA, name: 'User A', email: 'a@example.com', emailVerified: true, createdAt: now, updatedAt: now },
        { id: userB, name: 'User B', email: 'b@example.com', emailVerified: true, createdAt: now, updatedAt: now },
      ])
      await db.insert(sessionTable).values([
        { id: 'session-a-same', expiresAt, token: 'bearer-a-same', createdAt: now, updatedAt: now, userId: userA },
        { id: 'session-b-same', expiresAt, token: 'bearer-b-same', createdAt: now, updatedAt: now, userId: userB },
      ])
      await insertTrustedDevice('test-device-b-same', userB)

      await db.insert(settingsTable).values({
        key: 'shared_key',
        value: 'user-a-value',
        userId: userA,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-b-same', 'test-device-b-same'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'settings',
                id: 'shared_key',
                data: { value: 'user-b-attempt', user_id: userA },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'shared_key'))
      expect(rows).toHaveLength(2)
      const userARow = rows.find((r) => r.userId === userA)
      const userBRow = rows.find((r) => r.userId === userB)
      expect(userARow?.value).toBe('user-a-value')
      expect(userBRow?.value).toBe('user-b-attempt')
      // user_id from payload was ignored; User B's row has session user_id
      expect(userBRow?.userId).toBe(userB)
    })

    it('returns 200 and applies PATCH operation', async () => {
      const userId = 'user-upload-patch'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Patch User',
        email: 'upload-patch@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-patch',
        expiresAt,
        token: 'bearer-upload-patch',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      await db.insert(settingsTable).values({
        key: 'patch_setting',
        value: 'initial',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-patch'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PATCH' as const,
                type: 'settings',
                id: 'patch_setting',
                data: { value: 'updated_value' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'patch_setting'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('updated_value')
    })

    it('returns 200 for PATCH with empty data (no-op)', async () => {
      const userId = 'user-patch-empty'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Patch Empty User',
        email: 'patch-empty@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(sessionTable).values({
        id: 'session-patch-empty',
        expiresAt,
        token: 'bearer-patch-empty',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)
      await db.insert(settingsTable).values({
        key: 'empty_patch_setting',
        value: 'unchanged',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-patch-empty'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PATCH' as const,
                type: 'settings',
                id: 'empty_patch_setting',
                data: {},
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'empty_patch_setting'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('unchanged')
    })

    it('returns 400 when PATCH targets non-existent record', async () => {
      const userId = 'user-patch-nonexistent'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Patch Nonexistent User',
        email: 'patch-nonexistent@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(sessionTable).values({
        id: 'session-patch-nonexistent',
        expiresAt,
        token: 'bearer-patch-nonexistent',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)
      // No settings row exists for 'nonexistent_key'

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-patch-nonexistent'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PATCH' as const,
                type: 'settings',
                id: 'nonexistent_key',
                data: { value: 'updated' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('UPLOAD_OPERATION_FAILED')
    })

    it('returns 400 when PATCH targets record belonging to another user', async () => {
      const userA = 'user-patch-owner'
      const userB = 'user-patch-attacker'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values([
        {
          id: userA,
          name: 'Owner',
          email: 'patch-owner@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: userB,
          name: 'Attacker',
          email: 'patch-attacker@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      await db.insert(sessionTable).values([
        {
          id: 'session-patch-owner',
          expiresAt,
          token: 'bearer-patch-owner',
          createdAt: now,
          updatedAt: now,
          userId: userA,
        },
        {
          id: 'session-patch-attacker',
          expiresAt,
          token: 'bearer-patch-attacker',
          createdAt: now,
          updatedAt: now,
          userId: userB,
        },
      ])
      await insertTrustedDevice('test-device-patch-attacker', userB)
      await db.insert(settingsTable).values({
        key: 'owner_only_setting',
        value: 'owner_value',
        userId: userA,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-patch-attacker', 'test-device-patch-attacker'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PATCH' as const,
                type: 'settings',
                id: 'owner_only_setting',
                data: { value: 'attacker_overwrite' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('UPLOAD_OPERATION_FAILED')

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'owner_only_setting'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('owner_value')
      expect(rows[0]?.userId).toBe(userA)
    })

    it('ignores user_id and id in PATCH payload', async () => {
      const userId = 'user-patch-owns'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Patch Owner',
        email: 'patch-owner@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(sessionTable).values({
        id: 'session-patch-owns',
        expiresAt,
        token: 'bearer-patch-owns',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)
      await db.insert(settingsTable).values({
        key: 'patch_owned',
        value: 'initial',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-patch-owns'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PATCH' as const,
                type: 'settings',
                id: 'patch_owned',
                data: { value: 'updated', user_id: 'other-user', id: 'other_id' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'patch_owned'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe(userId)
      expect(rows[0]?.value).toBe('updated')
    })

    it('converts deleted_at ISO string to Date in PATCH (prompts soft delete)', async () => {
      const userId = 'user-patch-deleted-at'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Patch DeletedAt User',
        email: 'patch-deleted-at@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(sessionTable).values({
        id: 'session-patch-deleted-at',
        expiresAt,
        token: 'bearer-patch-deleted-at',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)
      await db.insert(promptsTable).values({
        id: 'prompt-to-soft-delete',
        title: 'My Prompt',
        prompt: 'Hello',
        modelId: 'gpt-4',
        userId,
      })

      const deletedAtIso = '2026-02-18T16:41:12.428Z'
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-patch-deleted-at'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PATCH' as const,
                type: 'prompts',
                id: 'prompt-to-soft-delete',
                data: { deleted_at: deletedAtIso, model_id: null, prompt: null, title: null },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(promptsTable).where(eq(promptsTable.id, 'prompt-to-soft-delete'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.deletedAt).toEqual(new Date(deletedAtIso))
      expect(rows[0]?.modelId).toBeNull()
      expect(rows[0]?.prompt).toBeNull()
      expect(rows[0]?.title).toBeNull()
    })

    it('returns 200 and applies DELETE operation', async () => {
      const userId = 'user-upload-delete'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Delete User',
        email: 'upload-delete@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-delete',
        expiresAt,
        token: 'bearer-upload-delete',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      await db.insert(settingsTable).values({
        key: 'to_delete',
        value: 'x',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-delete'),
          body: JSON.stringify({
            operations: [{ op: 'DELETE' as const, type: 'settings', id: 'to_delete' }],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'to_delete'))
      expect(rows).toHaveLength(0)
    })

    it('returns 400 when DELETE targets non-existent record', async () => {
      const userId = 'user-delete-nonexistent'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Delete Nonexistent User',
        email: 'delete-nonexistent@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(sessionTable).values({
        id: 'session-delete-nonexistent',
        expiresAt,
        token: 'bearer-delete-nonexistent',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)
      // No settings row exists for 'nonexistent_to_delete'

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-delete-nonexistent'),
          body: JSON.stringify({
            operations: [{ op: 'DELETE' as const, type: 'settings', id: 'nonexistent_to_delete' }],
          }),
        }),
      )
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('UPLOAD_OPERATION_FAILED')
    })

    it('returns 400 when DELETE targets record belonging to another user', async () => {
      const userA = 'user-delete-owner'
      const userB = 'user-delete-attacker'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values([
        {
          id: userA,
          name: 'Owner',
          email: 'delete-owner@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: userB,
          name: 'Attacker',
          email: 'delete-attacker@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      await db.insert(sessionTable).values([
        {
          id: 'session-delete-owner',
          expiresAt,
          token: 'bearer-delete-owner',
          createdAt: now,
          updatedAt: now,
          userId: userA,
        },
        {
          id: 'session-delete-attacker',
          expiresAt,
          token: 'bearer-delete-attacker',
          createdAt: now,
          updatedAt: now,
          userId: userB,
        },
      ])
      await insertTrustedDevice('test-device-delete-attacker', userB)
      await db.insert(settingsTable).values({
        key: 'owner_only_to_delete',
        value: 'x',
        userId: userA,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-delete-attacker', 'test-device-delete-attacker'),
          body: JSON.stringify({
            operations: [{ op: 'DELETE' as const, type: 'settings', id: 'owner_only_to_delete' }],
          }),
        }),
      )
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('UPLOAD_OPERATION_FAILED')

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'owner_only_to_delete'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.userId).toBe(userA)
    })

    it('blocks DELETE on devices table (must use dedicated revoke API)', async () => {
      const userId = 'user-delete-device-blocked'
      const deviceId = 'device-to-delete-blocked'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Delete Device Blocked User',
        email: 'delete-device-blocked@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      await db.insert(sessionTable).values({
        id: 'session-delete-device-blocked',
        expiresAt,
        token: 'bearer-delete-device-blocked',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      // Insert a second device that the attacker will try to delete via PowerSync
      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Target Device',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-delete-device-blocked'),
          body: JSON.stringify({
            operations: [{ op: 'DELETE' as const, type: 'devices', id: deviceId }],
          }),
        }),
      )
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('UPLOAD_OPERATION_FAILED')

      // Device must still exist
      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.trusted).toBe(true)
    })

    it('ignores unknown and injection-like column names in PUT data', async () => {
      const userId = 'user-upload-safe'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Safe Upload User',
        email: 'upload-safe@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-safe',
        expiresAt,
        token: 'bearer-upload-safe',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-safe'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'settings',
                id: 'safe_key',
                data: {
                  value: 'expected',
                  '"; DROP TABLE settings; --': 'ignored',
                  invalid_column: 'ignored',
                },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'safe_key'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('expected')
      expect(rows[0]?.userId).toBe(userId)
    })

    it('two users can add the same setting key and each gets their own row', async () => {
      const userA = 'user-multi-a'
      const userB = 'user-multi-b'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values([
        {
          id: userA,
          name: 'User A',
          email: 'multi-a@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: userB,
          name: 'User B',
          email: 'multi-b@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      await db.insert(sessionTable).values([
        { id: 'session-multi-a', expiresAt, token: 'bearer-multi-a', createdAt: now, updatedAt: now, userId: userA },
        { id: 'session-multi-b', expiresAt, token: 'bearer-multi-b', createdAt: now, updatedAt: now, userId: userB },
      ])
      await insertTrustedDevice('test-device-multi-a', userA)
      await insertTrustedDevice('test-device-multi-b', userB)

      const responseA = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-multi-a', 'test-device-multi-a'),
          body: JSON.stringify({
            operations: [{ op: 'PUT' as const, type: 'settings', id: 'ui-theme', data: { value: 'dark' } }],
          }),
        }),
      )
      expect(responseA.status).toBe(200)

      const responseB = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-multi-b', 'test-device-multi-b'),
          body: JSON.stringify({
            operations: [{ op: 'PUT' as const, type: 'settings', id: 'ui-theme', data: { value: 'light' } }],
          }),
        }),
      )
      expect(responseB.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'ui-theme'))
      expect(rows).toHaveLength(2)
      const rowA = rows.find((r) => r.userId === userA)
      const rowB = rows.find((r) => r.userId === userB)
      expect(rowA?.value).toBe('dark')
      expect(rowB?.value).toBe('light')
    })

    it('two users can add and update their own settings without affecting each other', async () => {
      const userA = 'user-isolated-a'
      const userB = 'user-isolated-b'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values([
        {
          id: userA,
          name: 'Alice',
          email: 'isolated-a@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: userB,
          name: 'Bob',
          email: 'isolated-b@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      await db.insert(sessionTable).values([
        {
          id: 'session-isolated-a',
          expiresAt,
          token: 'bearer-isolated-a',
          createdAt: now,
          updatedAt: now,
          userId: userA,
        },
        {
          id: 'session-isolated-b',
          expiresAt,
          token: 'bearer-isolated-b',
          createdAt: now,
          updatedAt: now,
          userId: userB,
        },
      ])
      await insertTrustedDevice('test-device-isolated-a', userA)
      await insertTrustedDevice('test-device-isolated-b', userB)

      await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-isolated-a', 'test-device-isolated-a'),
          body: JSON.stringify({
            operations: [
              { op: 'PUT' as const, type: 'settings', id: 'preferred_name', data: { value: 'Alice' } },
              { op: 'PUT' as const, type: 'settings', id: 'ui-theme', data: { value: 'dark' } },
            ],
          }),
        }),
      )

      await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-isolated-b', 'test-device-isolated-b'),
          body: JSON.stringify({
            operations: [
              { op: 'PUT' as const, type: 'settings', id: 'preferred_name', data: { value: 'Bob' } },
              { op: 'PUT' as const, type: 'settings', id: 'ui-theme', data: { value: 'light' } },
            ],
          }),
        }),
      )

      await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-isolated-a', 'test-device-isolated-a'),
          body: JSON.stringify({
            operations: [
              { op: 'PATCH' as const, type: 'settings', id: 'preferred_name', data: { value: 'Alice Smith' } },
            ],
          }),
        }),
      )

      await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-isolated-b', 'test-device-isolated-b'),
          body: JSON.stringify({
            operations: [{ op: 'PATCH' as const, type: 'settings', id: 'ui-theme', data: { value: 'system' } }],
          }),
        }),
      )

      const preferredRows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'preferred_name'))
      expect(preferredRows).toHaveLength(2)
      expect(preferredRows.find((r) => r.userId === userA)?.value).toBe('Alice Smith')
      expect(preferredRows.find((r) => r.userId === userB)?.value).toBe('Bob')

      const themeRows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'ui-theme'))
      expect(themeRows).toHaveLength(2)
      expect(themeRows.find((r) => r.userId === userA)?.value).toBe('dark')
      expect(themeRows.find((r) => r.userId === userB)?.value).toBe('system')
    })

    it('returns 400 when an operation fails (invalid table, empty payload, etc.)', async () => {
      const userId = 'user-upload-fail'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Fail User',
        email: 'upload-fail@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-fail',
        expiresAt,
        token: 'bearer-upload-fail',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-fail'),
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'nonexistent_table',
                id: 'some_id',
                data: { value: 'x' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string; code: string; table: string; id: string; op: string }
      expect(data.error).toBe('Upload operation failed')
      expect(data.code).toBe('UPLOAD_OPERATION_FAILED')
      expect(data.table).toBe('nonexistent_table')
      expect(data.id).toBe('some_id')
      expect(data.op).toBe('PUT')
    })

    it('returns 200 with empty operations array', async () => {
      const userId = 'user-upload-empty'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Empty Ops User',
        email: 'upload-empty@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-empty',
        expiresAt,
        token: 'bearer-upload-empty',
        createdAt: now,
        updatedAt: now,
        userId,
      })
      await insertTrustedDevice('test-device-id', userId)

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: uploadHeaders('bearer-upload-empty'),
          body: JSON.stringify({ operations: [] }),
        }),
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { success: boolean }
      expect(data.success).toBe(true)
    })
  })
})

describe('PowerSync cross-origin injection protection', () => {
  const corsSettings: Settings = {
    ...powersyncSettings,
    corsOrigins: 'http://localhost:1420,tauri://localhost,http://tauri.localhost',
  }

  let app: Elysia
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const seedUser = async (userId: string, token: string, trustedDeviceId?: string) => {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)
    await db.insert(userTable).values({
      id: userId,
      name: 'CORS Test User',
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(sessionTable).values({
      id: `session-${userId}`,
      expiresAt,
      token,
      createdAt: now,
      updatedAt: now,
      userId,
    })
    if (trustedDeviceId) {
      await db.insert(devicesTable).values({
        id: trustedDeviceId,
        userId,
        name: 'CORS Test Device',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })
    }
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const { auth } = createBetterAuthPlugin(db)
    app = new Elysia().use(createPowerSyncRoutes(auth, corsSettings, db)) as unknown as Elysia
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('PUT /powersync/upload origin validation', () => {
    it('rejects upload from disallowed cross-origin (attacker port)', async () => {
      await seedUser('user-cors-upload', 'bearer-cors-upload', 'cors-test-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-cors-upload')}`,
            'X-Device-ID': 'cors-test-device',
            Origin: 'http://localhost:9999',
          },
          body: JSON.stringify({
            operations: [
              { op: 'PUT' as const, type: 'settings', id: 'cloud_url', data: { value: 'https://attacker.com/v1' } },
            ],
          }),
        }),
      )
      expect(response.status).toBe(403)
      const data = (await response.json()) as { code: string }
      expect(data.code).toBe('ORIGIN_NOT_ALLOWED')

      // Verify nothing was written
      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cloud_url'))
      expect(rows).toHaveLength(0)
    })

    it('rejects model injection from attacker origin', async () => {
      await seedUser('user-model-inject', 'bearer-model-inject', 'attacker-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-model-inject')}`,
            'X-Device-ID': 'attacker-device',
            Origin: 'http://localhost:9999',
          },
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'models',
                id: 'evil-model',
                data: {
                  provider: 'custom',
                  name: 'GPT-5 Ultra (Free)',
                  model: 'gpt-5',
                  url: 'https://attacker.com/v1',
                  enabled: 1,
                  tool_usage: 1,
                },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(403)

      const rows = await db.select().from(modelsTable).where(eq(modelsTable.id, 'evil-model'))
      expect(rows).toHaveLength(0)
    })

    it('rejects MCP server injection from attacker origin', async () => {
      await seedUser('user-mcp-inject', 'bearer-mcp-inject', 'attacker-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-mcp-inject')}`,
            'X-Device-ID': 'attacker-device',
            Origin: 'http://localhost:9999',
          },
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'mcp_servers',
                id: 'evil-mcp',
                data: {
                  name: 'Enhanced Tools',
                  type: 'http',
                  url: 'https://attacker.com/mcp',
                  enabled: 1,
                },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(403)

      const rows = await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, 'evil-mcp'))
      expect(rows).toHaveLength(0)
    })

    it('allows upload from legitimate origin (http://localhost:1420)', async () => {
      await seedUser('user-legit-origin', 'bearer-legit-origin', 'legit-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-legit-origin')}`,
            'X-Device-ID': 'legit-device',
            Origin: 'http://localhost:1420',
          },
          body: JSON.stringify({
            operations: [{ op: 'PUT' as const, type: 'settings', id: 'theme', data: { value: 'dark' } }],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'theme'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('dark')
    })

    it('allows upload from Tauri origin', async () => {
      await seedUser('user-tauri-origin', 'bearer-tauri-origin', 'tauri-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-tauri-origin')}`,
            'X-Device-ID': 'tauri-device',
            Origin: 'tauri://localhost',
          },
          body: JSON.stringify({
            operations: [{ op: 'PUT' as const, type: 'settings', id: 'tauri_setting', data: { value: 'yes' } }],
          }),
        }),
      )
      expect(response.status).toBe(200)
    })

    it('allows upload without Origin header (non-browser clients)', async () => {
      await seedUser('user-no-origin', 'bearer-no-origin', 'server-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-no-origin')}`,
            'X-Device-ID': 'server-device',
          },
          body: JSON.stringify({
            operations: [{ op: 'PUT' as const, type: 'settings', id: 'server_setting', data: { value: 'ok' } }],
          }),
        }),
      )
      expect(response.status).toBe(200)
    })

    it('rejects upload from external attacker domain', async () => {
      await seedUser('user-ext-attacker', 'bearer-ext-attacker', 'attacker-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken('bearer-ext-attacker')}`,
            'X-Device-ID': 'attacker-device',
            Origin: 'https://attacker.com',
          },
          body: JSON.stringify({
            operations: [
              { op: 'PUT' as const, type: 'settings', id: 'cloud_url', data: { value: 'https://attacker.com/v1' } },
            ],
          }),
        }),
      )
      expect(response.status).toBe(403)
    })
  })

  describe('GET /powersync/token origin validation', () => {
    it('rejects token request from disallowed origin', async () => {
      await seedUser('user-cors-token', 'bearer-cors-token', 'cors-token-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-cors-token')}`,
            'X-Device-ID': 'cors-token-device',
            Origin: 'http://localhost:9999',
          },
        }),
      )
      expect(response.status).toBe(403)
      const data = (await response.json()) as { code: string }
      expect(data.code).toBe('ORIGIN_NOT_ALLOWED')
    })

    it('allows token request from legitimate origin', async () => {
      await seedUser('user-legit-token', 'bearer-legit-token', 'legit-token-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-legit-token')}`,
            'X-Device-ID': 'legit-token-device',
            Origin: 'http://localhost:1420',
          },
        }),
      )
      expect(response.status).toBe(200)
    })

    it('allows token request without Origin header', async () => {
      await seedUser('user-no-origin-token', 'bearer-no-origin-token', 'no-origin-device')
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: `Bearer ${signToken('bearer-no-origin-token')}`,
            'X-Device-ID': 'no-origin-device',
          },
        }),
      )
      expect(response.status).toBe(200)
    })
  })
})

describe('PowerSync API (E2EE disabled)', () => {
  let app: Elysia
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const e2eeDisabledSettings: Settings = { ...powersyncSettings, e2eeEnabled: false }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const { auth } = createBetterAuthPlugin(db)
    app = new Elysia().use(createPowerSyncRoutes(auth, e2eeDisabledSettings, db)) as unknown as Elysia
  })

  afterEach(async () => {
    await cleanup()
  })

  it('allows untrusted device to get token when E2EE is disabled', async () => {
    const userId = 'user-e2ee-off'
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)

    await db.insert(userTable).values({
      id: userId,
      name: 'E2EE Off User',
      email: 'e2ee-off@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(sessionTable).values({
      id: 'session-e2ee-off',
      expiresAt,
      token: 'bearer-e2ee-off',
      createdAt: now,
      updatedAt: now,
      userId,
    })

    await db.insert(devicesTable).values({
      id: 'untrusted-device-e2ee-off',
      userId,
      name: 'Untrusted Device',
      trusted: false,
      lastSeen: now,
      createdAt: now,
    })

    const response = await app.handle(
      new Request('http://localhost/powersync/token', {
        headers: {
          Authorization: `Bearer ${signToken('bearer-e2ee-off')}`,
          'x-device-id': 'untrusted-device-e2ee-off',
        },
      }),
    )
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.token).toBeDefined()
    expect(data.powerSyncUrl).toBe('https://powersync.example.com')
  })

  it('creates and trusts a brand-new device on token request when E2EE is disabled', async () => {
    const userId = 'user-new-device-e2ee-off'
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)

    await db.insert(userTable).values({
      id: userId,
      name: 'New Device User',
      email: 'new-device-e2ee-off@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(sessionTable).values({
      id: 'session-new-device-e2ee-off',
      expiresAt,
      token: 'bearer-new-device-e2ee-off',
      createdAt: now,
      updatedAt: now,
      userId,
    })

    // No device inserted — device does not exist in DB at all
    const response = await app.handle(
      new Request('http://localhost/powersync/token', {
        headers: {
          Authorization: `Bearer ${signToken('bearer-new-device-e2ee-off')}`,
          'x-device-id': 'brand-new-device',
          'x-device-name': 'My New Phone',
        },
      }),
    )
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.token).toBeDefined()
    expect(data.powerSyncUrl).toBe('https://powersync.example.com')

    // Verify device was auto-created and trusted
    const device = await db
      .select({ userId: devicesTable.userId, trusted: devicesTable.trusted, name: devicesTable.name })
      .from(devicesTable)
      .where(eq(devicesTable.id, 'brand-new-device'))
      .then((rows) => rows[0])
    expect(device).toBeDefined()
    expect(device.userId).toBe(userId)
    expect(device.trusted).toBe(true)
    expect(device.name).toBe('My New Phone')
  })

  it('auto-trusts new device on upsert when E2EE is disabled', async () => {
    const userId = 'user-auto-trust'
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)

    await db.insert(userTable).values({
      id: userId,
      name: 'Auto Trust User',
      email: 'auto-trust@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(sessionTable).values({
      id: 'session-auto-trust',
      expiresAt,
      token: 'bearer-auto-trust',
      createdAt: now,
      updatedAt: now,
      userId,
    })

    // Insert untrusted device — the token endpoint should upgrade it to trusted
    await db.insert(devicesTable).values({
      id: 'device-auto-trust',
      userId,
      name: 'Device',
      trusted: false,
      lastSeen: now,
      createdAt: now,
    })

    const response = await app.handle(
      new Request('http://localhost/powersync/token', {
        headers: {
          Authorization: `Bearer ${signToken('bearer-auto-trust')}`,
          'x-device-id': 'device-auto-trust',
        },
      }),
    )
    expect(response.status).toBe(200)

    // Verify device was marked trusted in DB
    const device = await db
      .select({ trusted: devicesTable.trusted })
      .from(devicesTable)
      .where(eq(devicesTable.id, 'device-auto-trust'))
      .then((rows) => rows[0])
    expect(device.trusted).toBe(true)
  })

  it('rejects non-existent device on upload even when E2EE is disabled', async () => {
    const userId = 'user-upload-no-device'
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)

    await db.insert(userTable).values({
      id: userId,
      name: 'Upload No Device',
      email: 'upload-no-device@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(sessionTable).values({
      id: 'session-upload-no-device',
      expiresAt,
      token: 'bearer-upload-no-device',
      createdAt: now,
      updatedAt: now,
      userId,
    })

    const response = await app.handle(
      new Request('http://localhost/powersync/upload', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${signToken('bearer-upload-no-device')}`,
          'X-Device-ID': 'device-does-not-exist',
        },
        body: JSON.stringify({
          operations: [{ op: 'PUT', type: 'settings', id: 'k', data: { value: 'v' } }],
        }),
      }),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'DEVICE_NOT_TRUSTED' })
  })

  it('still rejects revoked device when E2EE is disabled', async () => {
    const userId = 'user-revoked-e2ee-off'
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)

    await db.insert(userTable).values({
      id: userId,
      name: 'Revoked E2EE Off',
      email: 'revoked-e2ee-off@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })

    await db.insert(sessionTable).values({
      id: 'session-revoked-e2ee-off',
      expiresAt,
      token: 'bearer-revoked-e2ee-off',
      createdAt: now,
      updatedAt: now,
      userId,
    })

    await db.insert(devicesTable).values({
      id: 'revoked-device-e2ee-off',
      userId,
      name: 'Revoked Device',
      trusted: false,
      revokedAt: now,
      lastSeen: now,
      createdAt: now,
    })

    const response = await app.handle(
      new Request('http://localhost/powersync/token', {
        headers: {
          Authorization: `Bearer ${signToken('bearer-revoked-e2ee-off')}`,
          'x-device-id': 'revoked-device-e2ee-off',
        },
      }),
    )
    expect(response.status).toBe(403)
    const data = await response.json()
    expect(data).toEqual({ code: 'DEVICE_DISCONNECTED' })
  })
})

describe('PowerSync API (not configured)', () => {
  it('GET /powersync/token returns 404 when PowerSync is not configured', async () => {
    const testEnv = await createTestDb()
    const { auth } = createBetterAuthPlugin(testEnv.db)
    const noPowersyncSettings: Settings = {
      ...powersyncSettings,
      powersyncJwtSecret: '',
      powersyncUrl: '',
    }
    const app = new Elysia().use(createPowerSyncRoutes(auth, noPowersyncSettings, testEnv.db)) as unknown as Elysia

    const response = await app.handle(new Request('http://localhost/powersync/token'))
    expect(response.status).toBe(404)

    await testEnv.cleanup()
  })
})
