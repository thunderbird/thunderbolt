/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { session as sessionTable, user } from '@/db/auth-schema'
import { encryptionMetadataTable, envelopesTable } from '@/db/encryption-schema'
import { chatThreadsTable, devicesTable, settingsTable, tasksTable } from '@/db/schema'
import { linkCliSessionToDevice } from '@/dal/sessions'
import { hashCanarySecret } from '@/lib/canary'
import { createTestDb } from '@/test-utils/db'
import { registerCliDevice } from '@/test-utils/cli-device'
import { createTestSettings } from '@/test-utils/settings'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createAccountRoutes } from './account'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'
const signToken = (token: string): string => {
  const sig = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${sig}`
}

/**
 * Unique-ID strategy for PGlite + nested transactions:
 *
 * The revoke endpoint calls database.transaction() internally. In PGlite's
 * single-connection model this commits the outer test transaction (started by
 * createTestDb's BEGIN), so ROLLBACK in afterEach becomes a no-op and rows persist.
 * CI runs each file 5× (test:backend:5x), so the second run would hit
 * unique-constraint violations without unique IDs.
 *
 * Fix: p() prefixes every ID with a globalThis counter that survives module re-evaluation
 * (bun's --rerun-each reloads the module, resetting module-scope variables).
 */
const counterKey = Symbol.for('account-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

/** Known canary secret for tests that require proof-of-CK-possession. */
const testCanarySecret = 'test-canary-secret-for-revoke-proof'

describe('Account API', () => {
  let app: { handle: (request: Request) => Promise<Response> }
  let auth: ReturnType<typeof createAuth>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  /** Prefix IDs with the current runId — see top-of-file comment for why. */
  let p: (id: string) => string

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `${rid}-${id}`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    auth = createAuth(db)
    app = new Elysia({ prefix: '/v1' }).use(
      createAccountRoutes(auth, createTestSettings({ betterAuthSecret, cliDeviceRegistrationEnabled: true }), db),
    )
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  /** Create a user, session, and trusted caller device. Returns { now, callerDeviceId }. */
  const createUserSessionAndDevice = async (userId: string, token: string, callerDeviceId: string) => {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 3600 * 1000)

    await db.insert(user).values({
      id: userId,
      name: 'Test User',
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
      deviceId: callerDeviceId,
    })

    await db.insert(devicesTable).values({
      id: callerDeviceId,
      userId,
      name: 'Caller Device',
      lastSeen: now,
      createdAt: now,
      trusted: true,
    })

    return now
  }

  /** Create a user and persisted session for CLI-account route tests. */
  const createCliSession = async (
    userId: string,
    token: string,
    options: { deviceId?: string; expiresAt?: Date; isAnonymous?: boolean } = {},
  ) => {
    const now = new Date()
    await db.insert(user).values({
      id: userId,
      name: 'CLI User',
      email: `${userId}@example.com`,
      emailVerified: !options.isAnonymous,
      isAnonymous: options.isAnonymous ?? false,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(sessionTable).values({
      id: `cli-session-${userId}`,
      expiresAt: options.expiresAt ?? new Date(now.getTime() + 3600_000),
      token,
      createdAt: now,
      updatedAt: now,
      userId,
      deviceId: options.deviceId ?? null,
    })
    return now
  }

  const registerCli = (token: string, deviceId: string, options: { name?: string; appVersion?: string | null } = {}) =>
    registerCliDevice(app, signToken(token), deviceId, options)

  /** Send the bodyless CLI logout request. */
  const logoutCli = (token: string) =>
    app.handle(
      new Request('http://localhost/v1/account/devices/cli/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${signToken(token)}` },
      }),
    )

  /** Insert encryption metadata with a known canary secret hash. */
  const insertCanaryWithSecret = async (userId: string) => {
    const hash = await hashCanarySecret(testCanarySecret)
    const now = new Date()
    await db.insert(encryptionMetadataTable).values({
      userId,
      canaryIv: 'iv-test',
      canaryCtext: 'ctext-test',
      canarySecretHash: hash,
      createdAt: now,
    })
  }

  /** Build a revoke request with proper headers and body. */
  const revokeRequest = (
    deviceId: string,
    token: string,
    opts?: { callerDeviceId?: string; canarySecret?: string; omitDeviceHeader?: boolean },
  ) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${signToken(token)}`,
      'Content-Type': 'application/json',
    }
    if (!opts?.omitDeviceHeader && opts?.callerDeviceId) {
      headers['X-Device-ID'] = opts.callerDeviceId
    }
    const body = opts?.canarySecret ? JSON.stringify({ canarySecret: opts.canarySecret }) : '{}'
    return new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
      method: 'POST',
      headers,
      body,
    })
  }

  describe('CLI account device lifecycle', () => {
    it('keeps CLI registration unavailable until the server rollout gate is enabled', async () => {
      const userId = p('cli-rollout-disabled-user')
      const token = p('cli-rollout-disabled-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)
      const disabledApp = new Elysia({ prefix: '/v1' }).use(
        createAccountRoutes(auth, createTestSettings({ betterAuthSecret, cliDeviceRegistrationEnabled: false }), db),
      )

      const response = await registerCliDevice(disabledApp, signToken(token), deviceId)

      expect(response.status).toBe(404)
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
    })

    it('registers an exact CLI row, binds the real session, and idempotently touches the same row', async () => {
      const userId = p('cli-register-user')
      const token = p('cli-register-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)

      const registered = await registerCli(token, deviceId, { name: 'Workstation', appVersion: '1.0.0' })
      expect(registered.status).toBe(200)
      expect(await registered.json()).toEqual({ deviceId, state: 'registered' })

      const [firstRow] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(firstRow).toMatchObject({
        id: deviceId,
        userId,
        name: 'Workstation',
        appVersion: '1.0.0',
        deviceType: 'cli',
        trusted: true,
        approvalPending: false,
        publicKey: null,
        mlkemPublicKey: null,
        nodeId: null,
        nodeIdAttestedAt: null,
        revokedAt: null,
      })
      const [boundSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(boundSession.deviceId).toBe(deviceId)

      await db.insert(devicesTable).values(
        Array.from({ length: 9 }, (_, index) => ({
          id: p(`cli-touch-cap-device-${index}`),
          userId,
          name: `Device ${index}`,
          trusted: true,
          lastSeen: firstRow.lastSeen!,
          createdAt: firstRow.createdAt!,
        })),
      )

      const touched = await registerCli(token, deviceId, { name: 'Renamed Workstation', appVersion: '1.1.0' })
      expect(touched.status).toBe(200)
      expect(await touched.json()).toEqual({ deviceId, state: 'registered' })
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        name: 'Renamed Workstation',
        appVersion: '1.1.0',
        createdAt: firstRow.createdAt,
        deviceType: 'cli',
        trusted: true,
        approvalPending: false,
      })
      expect(rows[0].lastSeen!.getTime()).toBeGreaterThanOrEqual(firstRow.lastSeen!.getTime())
    })

    it('rejects malformed and non-canonical CLI device IDs without creating a row', async () => {
      const userId = p('cli-invalid-id-user')
      const token = p('cli-invalid-id-token')
      await createCliSession(userId, token)
      const invalidIds = ['cli-not-a-uuid', 'cli-019F0000-0000-7000-8000-000000000001', crypto.randomUUID()]

      for (const deviceId of invalidIds) {
        const response = await registerCli(token, deviceId)
        expect(response.status).toBe(400)
        expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
      }
    })

    it('rejects a missing X-App-Version without creating or binding a CLI device', async () => {
      const userId = p('cli-missing-version-user')
      const token = p('cli-missing-version-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)

      const response = await registerCli(token, deviceId, { appVersion: null })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: 'INVALID_APP_VERSION' })
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBeNull()
    })

    it('rejects a blank X-App-Version without creating or binding a CLI device', async () => {
      const userId = p('cli-blank-version-user')
      const token = p('cli-blank-version-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)

      const response = await registerCli(token, deviceId, { appVersion: '   ' })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: 'INVALID_APP_VERSION' })
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBeNull()
    })

    it('requires the persisted session binding to be null or the same CLI device', async () => {
      const userId = p('cli-bound-user')
      const token = p('cli-bound-token')
      const existingDeviceId = `cli-${crypto.randomUUID()}`
      const attemptedDeviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token, { deviceId: existingDeviceId })
      const now = new Date()
      await db.insert(devicesTable).values({
        id: existingDeviceId,
        userId,
        name: 'Existing CLI',
        deviceType: 'cli',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      const response = await registerCli(token, attemptedDeviceId)

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ code: 'SESSION_DEVICE_MISMATCH' })
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, attemptedDeviceId))).toHaveLength(0)
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBe(existingDeviceId)
    })

    it('serializes competing registrations so only one device wins the session bind', async () => {
      const userId = p('cli-bind-race-user')
      const token = p('cli-bind-race-token')
      const deviceIds = [`cli-${crypto.randomUUID()}`, `cli-${crypto.randomUUID()}`]
      await createCliSession(userId, token)

      const responses = await Promise.all(deviceIds.map((deviceId) => registerCli(token, deviceId)))
      expect(responses.map(({ status }) => status).sort()).toEqual([200, 409])

      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(deviceIds).toContain(persistedSession.deviceId!)
      const winnerRows = await db.select().from(devicesTable).where(eq(devicesTable.id, persistedSession.deviceId!))
      const losingDeviceId = deviceIds.find((deviceId) => deviceId !== persistedSession.deviceId)!
      const loserRows = await db.select().from(devicesTable).where(eq(devicesTable.id, losingDeviceId))
      expect(winnerRows).toHaveLength(1)
      expect(loserRows).toHaveLength(0)
    })

    it('returns authoritative 401 and rolls back the CLI row when the session is deleted before bind', async () => {
      const userId = p('cli-bind-delete-user')
      const token = p('cli-bind-delete-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)
      const deleteBeforeBind: typeof linkCliSessionToDevice = async (
        database,
        sessionId,
        targetDeviceId,
        targetUserId,
      ) => {
        await database.delete(sessionTable).where(eq(sessionTable.id, sessionId))
        return linkCliSessionToDevice(database, sessionId, targetDeviceId, targetUserId)
      }
      const boundaryApp = new Elysia({ prefix: '/v1' }).use(
        createAccountRoutes(auth, createTestSettings({ betterAuthSecret, cliDeviceRegistrationEnabled: true }), db, {
          linkCliSessionToDevice: deleteBeforeBind,
        }),
      )

      const response = await registerCliDevice(boundaryApp, signToken(token), deviceId)

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Unauthorized' })
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
    })

    it('returns authoritative 401 and rolls back the CLI row when the session expires before bind', async () => {
      const userId = p('cli-bind-expiry-user')
      const token = p('cli-bind-expiry-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)
      const expireBeforeBind: typeof linkCliSessionToDevice = async (
        database,
        sessionId,
        targetDeviceId,
        targetUserId,
      ) => {
        await database
          .update(sessionTable)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(sessionTable.id, sessionId))
        return linkCliSessionToDevice(database, sessionId, targetDeviceId, targetUserId)
      }
      const boundaryApp = new Elysia({ prefix: '/v1' }).use(
        createAccountRoutes(auth, createTestSettings({ betterAuthSecret, cliDeviceRegistrationEnabled: true }), db, {
          linkCliSessionToDevice: expireBeforeBind,
        }),
      )

      const response = await registerCliDevice(boundaryApp, signToken(token), deviceId)

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Unauthorized' })
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
    })

    it('returns 409 and rolls back the CLI row when bind discovers an active session bound elsewhere', async () => {
      const userId = p('cli-bind-conflict-user')
      const token = p('cli-bind-conflict-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      const competingDeviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)
      const bindCompetingDevice: typeof linkCliSessionToDevice = async (database, sessionId) => {
        await database.update(sessionTable).set({ deviceId: competingDeviceId }).where(eq(sessionTable.id, sessionId))
        return { status: 'conflict' }
      }
      const boundaryApp = new Elysia({ prefix: '/v1' }).use(
        createAccountRoutes(auth, createTestSettings({ betterAuthSecret, cliDeviceRegistrationEnabled: true }), db, {
          linkCliSessionToDevice: bindCompetingDevice,
        }),
      )

      const response = await registerCliDevice(boundaryApp, signToken(token), deviceId)

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ code: 'SESSION_DEVICE_MISMATCH' })
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
    })

    it('enforces the active-device cap for a new CLI row', async () => {
      const userId = p('cli-cap-user')
      const token = p('cli-cap-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      const now = await createCliSession(userId, token)
      await db.insert(devicesTable).values(
        Array.from({ length: 10 }, (_, index) => ({
          id: p(`cli-cap-device-${index}`),
          userId,
          name: `Device ${index}`,
          trusted: true,
          lastSeen: now,
          createdAt: now,
        })),
      )

      const response = await registerCli(token, deviceId)

      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ code: 'DEVICE_LIMIT_REACHED' })
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBeNull()
    })

    it('does not convert a colliding row owned by another account', async () => {
      const ownerId = p('cli-collision-owner')
      const callerId = p('cli-collision-caller')
      const callerToken = p('cli-collision-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      const now = await createCliSession(ownerId, p('cli-collision-owner-token'))
      await createCliSession(callerId, callerToken)
      await db.insert(devicesTable).values({
        id: deviceId,
        userId: ownerId,
        name: 'Owner Device',
        deviceType: 'cli',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      const response = await registerCli(callerToken, deviceId)

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ code: 'DEVICE_ID_TAKEN' })
      const [persisted] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(persisted).toMatchObject({ userId: ownerId, name: 'Owner Device', deviceType: 'cli' })
      const [callerSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, callerToken))
      expect(callerSession.deviceId).toBeNull()
    })

    it('returns DEVICE_DISCONNECTED without resurrecting a CLI tombstone', async () => {
      const userId = p('cli-tombstone-user')
      const token = p('cli-tombstone-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      const now = await createCliSession(userId, token)
      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Revoked CLI',
        deviceType: 'cli',
        trusted: false,
        revokedAt: now,
        lastSeen: now,
        createdAt: now,
      })

      const response = await registerCli(token, deviceId)

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ code: 'DEVICE_DISCONNECTED' })
      const [persisted] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(persisted).toMatchObject({ name: 'Revoked CLI', trusted: false, revokedAt: now })
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBeNull()
    })

    it('rejects an expired but correctly signed bearer on registration without mutation', async () => {
      const userId = p('cli-expired-register-user')
      const token = p('cli-expired-register-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token, { expiresAt: new Date(Date.now() - 1_000) })

      const response = await registerCli(token, deviceId)

      expect(response.status).toBe(401)
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBeNull()
    })

    it('rejects an expired but correctly signed bearer on logout without mutation', async () => {
      const userId = p('cli-expired-logout-user')
      const token = p('cli-expired-logout-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      const now = await createCliSession(userId, token, {
        deviceId,
        expiresAt: new Date(Date.now() - 1_000),
      })
      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Expired Session CLI',
        deviceType: 'cli',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      const response = await logoutCli(token)

      expect(response.status).toBe(401)
      const [persistedDevice] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(persistedDevice.revokedAt).toBeNull()
      expect(await db.select().from(sessionTable).where(eq(sessionTable.token, token))).toHaveLength(1)
    })

    it('rejects PAT authentication without creating or binding a CLI device', async () => {
      const userId = p('cli-pat-user')
      const token = p('cli-pat-session-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token)
      const apiKey = await auth.api.createApiKey({
        body: {},
        headers: new Headers({ Authorization: `Bearer ${signToken(token)}` }),
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account/devices/cli', {
          method: 'PUT',
          headers: {
            'x-api-key': apiKey.key,
            'X-Device-ID': deviceId,
            'X-Device-Name': 'PAT CLI',
          },
        }),
      )

      expect(response.status).toBe(401)
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBeNull()

      const logoutResponse = await app.handle(
        new Request('http://localhost/v1/account/devices/cli/logout', {
          method: 'POST',
          headers: { 'x-api-key': apiKey.key },
        }),
      )
      expect(logoutResponse.status).toBe(401)
      expect(await db.select().from(sessionTable).where(eq(sessionTable.token, token))).toHaveLength(1)
    })

    it('rejects a synthetic authenticated session that has no persisted session row', async () => {
      const userId = p('cli-synthetic-user')
      const now = new Date()
      await db.insert(user).values({
        id: userId,
        name: 'Synthetic User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      const deviceId = `cli-${crypto.randomUUID()}`

      const response = await app.handle(
        new Request('http://localhost/v1/account/devices/cli', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${signToken(p('synthetic-token'))}`,
            'X-Device-ID': deviceId,
            'X-Device-Name': 'Synthetic CLI',
          },
        }),
      )

      expect(response.status).toBe(401)
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
    })

    it('rejects an anonymous persisted account session', async () => {
      const userId = p('cli-anonymous-user')
      const token = p('cli-anonymous-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      await createCliSession(userId, token, { isAnonymous: true })

      const response = await registerCli(token, deviceId)

      expect(response.status).toBe(401)
      expect(await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))).toHaveLength(0)
      const [persistedSession] = await db.select().from(sessionTable).where(eq(sessionTable.token, token))
      expect(persistedSession.deviceId).toBeNull()
    })

    it('self-logout soft-revokes the bound CLI device and deletes every linked session', async () => {
      const userId = p('cli-self-logout-user')
      const token = p('cli-self-logout-token')
      const deviceId = `cli-${crypto.randomUUID()}`
      const now = await createCliSession(userId, token, { deviceId })
      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Logout CLI',
        deviceType: 'cli',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })
      await db.insert(sessionTable).values({
        id: p('cli-self-logout-second-session'),
        expiresAt: new Date(now.getTime() + 3600_000),
        token: p('cli-self-logout-second-token'),
        createdAt: now,
        updatedAt: now,
        userId,
        deviceId,
      })

      const response = await logoutCli(token)

      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      const [persistedDevice] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(persistedDevice.revokedAt).not.toBeNull()
      expect(persistedDevice.trusted).toBe(false)
      expect(await db.select().from(sessionTable).where(eq(sessionTable.deviceId, deviceId))).toHaveLength(0)
    })

    it('does not log out or revoke a session bound to a non-CLI device', async () => {
      const userId = p('cli-logout-normal-user')
      const token = p('cli-logout-normal-token')
      const deviceId = p('cli-logout-normal-device')
      const now = await createCliSession(userId, token, { deviceId })
      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Normal Device',
        deviceType: 'normal',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      const response = await logoutCli(token)

      expect(response.status).toBe(409)
      const [persistedDevice] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(persistedDevice.revokedAt).toBeNull()
      expect(await db.select().from(sessionTable).where(eq(sessionTable.token, token))).toHaveLength(1)
    })

    it('remote revoke uses the same soft-revoke and linked-session deletion path for a CLI target', async () => {
      const userId = p('cli-remote-revoke-user')
      const token = p('cli-remote-revoke-token')
      const callerDeviceId = p('cli-remote-revoke-caller')
      const targetDeviceId = `cli-${crypto.randomUUID()}`
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await db.insert(devicesTable).values({
        id: targetDeviceId,
        userId,
        name: 'Remote CLI',
        deviceType: 'cli',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })
      await db.insert(sessionTable).values({
        id: p('cli-remote-linked-session'),
        expiresAt: new Date(now.getTime() + 3600_000),
        token: p('cli-remote-linked-token'),
        createdAt: now,
        updatedAt: now,
        userId,
        deviceId: targetDeviceId,
      })

      const response = await app.handle(revokeRequest(targetDeviceId, token, { callerDeviceId }))

      expect(response.status).toBe(204)
      const [persistedDevice] = await db.select().from(devicesTable).where(eq(devicesTable.id, targetDeviceId))
      expect(persistedDevice.revokedAt).not.toBeNull()
      expect(await db.select().from(sessionTable).where(eq(sessionTable.deviceId, targetDeviceId))).toHaveLength(0)
    })

    it('rejects a trusted CLI caller for E2EE remote revoke', async () => {
      const userId = p('cli-e2ee-revoke-user')
      const token = p('cli-e2ee-revoke-token')
      const callerDeviceId = `cli-${crypto.randomUUID()}`
      const targetDeviceId = p('cli-e2ee-revoke-target')
      const now = await createCliSession(userId, token, { deviceId: callerDeviceId })
      await db.insert(devicesTable).values([
        {
          id: callerDeviceId,
          userId,
          name: 'CLI Caller',
          deviceType: 'cli',
          trusted: true,
          lastSeen: now,
          createdAt: now,
        },
        {
          id: targetDeviceId,
          userId,
          name: 'Normal Target',
          deviceType: 'normal',
          trusted: true,
          lastSeen: now,
          createdAt: now,
        },
      ])
      await insertCanaryWithSecret(userId)

      const response = await app.handle(
        revokeRequest(targetDeviceId, token, { callerDeviceId, canarySecret: testCanarySecret }),
      )

      expect(response.status).toBe(403)
      const [persistedTarget] = await db.select().from(devicesTable).where(eq(devicesTable.id, targetDeviceId))
      expect(persistedTarget.revokedAt).toBeNull()
    })

    it('rejects a trusted bridge caller for E2EE remote revoke', async () => {
      const userId = p('bridge-e2ee-revoke-user')
      const token = p('bridge-e2ee-revoke-token')
      const callerDeviceId = p('bridge-e2ee-revoke-caller')
      const targetDeviceId = p('bridge-e2ee-revoke-target')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await db.update(devicesTable).set({ deviceType: 'bridge' }).where(eq(devicesTable.id, callerDeviceId))
      await db.insert(devicesTable).values({
        id: targetDeviceId,
        userId,
        name: 'Normal Target',
        deviceType: 'normal',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })
      await insertCanaryWithSecret(userId)

      const response = await app.handle(
        revokeRequest(targetDeviceId, token, { callerDeviceId, canarySecret: testCanarySecret }),
      )

      expect(response.status).toBe(403)
      const [persistedTarget] = await db.select().from(devicesTable).where(eq(devicesTable.id, targetDeviceId))
      expect(persistedTarget.revokedAt).toBeNull()
    })
  })

  describe('POST /v1/account/devices/:id/revoke (session behavior)', () => {
    it('revokes only sessions linked to the revoked device', async () => {
      const userId = p('session-revoke-user')
      const token = p('session-revoke-token')
      const attackerToken = p('session-revoke-attacker-token')
      const deviceId = p('device-to-revoke')
      const myDeviceId = p('my-device')
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Session Revoke User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      // Create two sessions: one linked to my device, one linked to the compromised device
      const sessionId = p('session-user-revoking')
      const attackerSessionId = p('session-attacker')
      await db.insert(sessionTable).values([
        {
          id: sessionId,
          expiresAt,
          token,
          createdAt: now,
          updatedAt: now,
          userId,
          deviceId: myDeviceId,
        },
        {
          id: attackerSessionId,
          expiresAt,
          token: attackerToken,
          createdAt: now,
          updatedAt: now,
          userId,
          deviceId,
        },
      ])

      await db.insert(devicesTable).values([
        {
          id: myDeviceId,
          userId,
          name: 'My Device',
          trusted: true,
          lastSeen: now,
          createdAt: now,
        },
        {
          id: deviceId,
          userId,
          name: 'Compromised Device',
          lastSeen: now,
          createdAt: now,
        },
      ])

      // No encryption metadata — pre-encryption user path (no canary needed)
      const response = await app.handle(revokeRequest(deviceId, token, { callerDeviceId: myDeviceId }))
      expect(response.status).toBe(204)

      // My session (linked to my device) should still exist
      const revokingSession = await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId))
      expect(revokingSession).toHaveLength(1)

      // The compromised device's session should be deleted
      const attackerSession = await db.select().from(sessionTable).where(eq(sessionTable.id, attackerSessionId))
      expect(attackerSession).toHaveLength(0)
    })

    it('preserves revoking session when it is on a different device', async () => {
      const userId = p('single-session-user')
      const token = p('single-session-token')
      const sessionId = p('session-only-one')
      const myDeviceId = p('my-device-single')
      const deviceId = p('device-single-session')
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Single Session User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: sessionId,
        expiresAt,
        token,
        createdAt: now,
        updatedAt: now,
        userId,
        deviceId: myDeviceId,
      })

      await db.insert(devicesTable).values([
        {
          id: myDeviceId,
          userId,
          name: 'My Device',
          trusted: true,
          lastSeen: now,
          createdAt: now,
        },
        {
          id: deviceId,
          userId,
          name: 'Device',
          lastSeen: now,
          createdAt: now,
        },
      ])

      const response = await app.handle(revokeRequest(deviceId, token, { callerDeviceId: myDeviceId }))
      expect(response.status).toBe(204)

      // Session should still exist (linked to a different device)
      const sessions = await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId))
      expect(sessions).toHaveLength(1)
    })

    it('does not invalidate sessions when revoking a nonexistent device', async () => {
      const userId = p('nonexistent-revoke-user')
      const token = p('nonexistent-revoke-token')
      const otherToken = p('nonexistent-revoke-other-token')
      const sessionId = p('session-revoker')
      const otherSessionId = p('session-other')
      const callerDeviceId = p('caller-device-nonexist')
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Nonexistent Revoke User',
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(devicesTable).values({
        id: callerDeviceId,
        userId,
        name: 'Caller Device',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      await db.insert(sessionTable).values([
        {
          id: sessionId,
          expiresAt,
          token,
          createdAt: now,
          updatedAt: now,
          userId,
          deviceId: callerDeviceId,
        },
        {
          id: otherSessionId,
          expiresAt,
          token: otherToken,
          createdAt: now,
          updatedAt: now,
          userId,
        },
      ])

      // Revoke a device that doesn't exist — pre-encryption user (no canary needed)
      const response = await app.handle(revokeRequest('nonexistent-device', token, { callerDeviceId }))
      expect(response.status).toBe(204)

      // Both sessions should still exist — no device was actually revoked
      const revokerSession = await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId))
      expect(revokerSession).toHaveLength(1)
      const otherSession = await db.select().from(sessionTable).where(eq(sessionTable.id, otherSessionId))
      expect(otherSession).toHaveLength(1)
    })
  })

  describe('DELETE /v1/account', () => {
    it('should return 401 when not authenticated', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
        }),
      )
      expect(response.status).toBe(401)
    })

    it('should return 401 when Authorization header is missing', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      expect(response.status).toBe(401)
    })

    it('should return 204 and hard-delete user and app data when session is valid', async () => {
      const userId = 'test-user-full-delete'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Test User',
        email: 'full-delete@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      const sessionTable = (await import('@/db/auth-schema')).session
      await db.insert(sessionTable).values({
        id: 'session-full-delete',
        expiresAt,
        token: 'bearer-token-full-delete',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(settingsTable).values({
        key: 'test_setting',
        value: 'value',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${signToken('bearer-token-full-delete')}` },
        }),
      )

      expect(response.status).toBe(204)

      const usersLeft = await db.select().from(user).where(eq(user.id, userId))
      expect(usersLeft).toHaveLength(0)

      const settingsLeft = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId))
      expect(settingsLeft).toHaveLength(0)
    })

    it('cascade deletes all PowerSync rows when user is deleted (user_id foreign keys)', async () => {
      const userId = 'test-user-cascade-delete'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(user).values({
        id: userId,
        name: 'Cascade User',
        email: 'cascade-delete@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      const sessionTable = (await import('@/db/auth-schema')).session
      await db.insert(sessionTable).values({
        id: 'session-cascade-delete',
        expiresAt,
        token: 'bearer-token-cascade-delete',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(settingsTable).values({
        key: 'cascade_setting',
        value: 'v',
        userId,
      })
      await db.insert(devicesTable).values({
        id: 'device-cascade-1',
        userId,
        name: 'Device',
        lastSeen: now,
        createdAt: now,
      })
      await db.insert(tasksTable).values({
        id: 'task-cascade-1',
        item: 'Task',
        userId,
      })
      await db.insert(chatThreadsTable).values({
        id: 'thread-cascade-1',
        title: 'Thread',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/v1/account', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${signToken('bearer-token-cascade-delete')}` },
        }),
      )

      expect(response.status).toBe(204)

      const usersLeft = await db.select().from(user).where(eq(user.id, userId))
      expect(usersLeft).toHaveLength(0)

      const settingsLeft = await db.select().from(settingsTable).where(eq(settingsTable.userId, userId))
      expect(settingsLeft).toHaveLength(0)

      const devicesLeft = await db.select().from(devicesTable).where(eq(devicesTable.userId, userId))
      expect(devicesLeft).toHaveLength(0)

      const tasksLeft = await db.select().from(tasksTable).where(eq(tasksTable.userId, userId))
      expect(tasksLeft).toHaveLength(0)

      const threadsLeft = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.userId, userId))
      expect(threadsLeft).toHaveLength(0)
    })
  })

  describe('POST /v1/account/devices/:id/revoke (canary proof)', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account/devices/some-device/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 401 with invalid token', async () => {
      const response = await app.handle(
        new Request('http://localhost/v1/account/devices/some-device/revoke', {
          method: 'POST',
          headers: { Authorization: 'Bearer bogus-token', 'Content-Type': 'application/json' },
          body: '{}',
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 400 when X-Device-ID header is missing', async () => {
      const userId = p('no-header-user')
      const token = p('no-header-token')
      await createUserSessionAndDevice(userId, token, p('caller-no-header'))
      await insertCanaryWithSecret(userId)

      const response = await app.handle(revokeRequest(p('some-device'), token, { omitDeviceHeader: true }))
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toContain('X-Device-ID')
    })

    it('returns 403 when canarySecret is missing (E2EE active)', async () => {
      const userId = p('no-canary-user')
      const token = p('no-canary-token')
      const callerDeviceId = p('caller-no-canary')
      await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertCanaryWithSecret(userId)

      const response = await app.handle(revokeRequest(p('target-device'), token, { callerDeviceId }))
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toContain('Canary secret required')
    })

    it('returns 403 when canarySecret is invalid', async () => {
      const userId = p('bad-canary-user')
      const token = p('bad-canary-token')
      const callerDeviceId = p('caller-bad-canary')
      await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertCanaryWithSecret(userId)

      const response = await app.handle(
        revokeRequest(p('target-device'), token, {
          callerDeviceId,
          canarySecret: 'wrong-secret',
        }),
      )
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toContain('Invalid canary secret')
    })

    it('returns 403 when caller device is not trusted', async () => {
      const userId = p('untrusted-caller-user')
      const token = p('untrusted-caller-token')
      const callerDeviceId = p('caller-untrusted')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertCanaryWithSecret(userId)

      // Mark the caller device as untrusted
      await db.update(devicesTable).set({ trusted: false }).where(eq(devicesTable.id, callerDeviceId))

      const targetDeviceId = p('target-untrusted-test')
      await db.insert(devicesTable).values({
        id: targetDeviceId,
        userId,
        name: 'Target Device',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      const response = await app.handle(
        revokeRequest(targetDeviceId, token, {
          callerDeviceId,
          canarySecret: testCanarySecret,
        }),
      )
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toContain('Only trusted devices')
    })

    it('returns 204 and revokes device + deletes envelope (with canary proof)', async () => {
      const userId = p('revoke-user')
      const token = p('revoke-token')
      const callerDeviceId = p('caller-revoke')
      const deviceId = p('device-to-revoke')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertCanaryWithSecret(userId)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'My Device',
        lastSeen: now,
        createdAt: now,
        trusted: true,
      })

      await db.insert(envelopesTable).values({
        deviceId,
        userId,
        wrappedCk: 'wrapped-key-data',
        updatedAt: now,
      })

      const response = await app.handle(
        revokeRequest(deviceId, token, {
          callerDeviceId,
          canarySecret: testCanarySecret,
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).not.toBeNull()

      const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, deviceId))
      expect(envelopes).toHaveLength(0)
    })

    it('does not revoke device belonging to different user', async () => {
      const userAId = p('user-a-revoke')
      const userBId = p('user-b-revoke')
      const tokenA = p('token-user-a')
      const callerDeviceA = p('caller-device-a')
      const deviceId = p('device-user-b')

      await createUserSessionAndDevice(userAId, tokenA, callerDeviceA)
      // User A has no encryption metadata — pre-encryption path

      const now = await createUserSessionAndDevice(userBId, p('token-user-b'), p('caller-device-b'))

      await db.insert(devicesTable).values({
        id: deviceId,
        userId: userBId,
        name: 'User B Device',
        lastSeen: now,
        createdAt: now,
        trusted: true,
      })

      const response = await app.handle(revokeRequest(deviceId, tokenA, { callerDeviceId: callerDeviceA }))

      // Returns 204 (idempotent) but device is NOT actually revoked
      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.trusted).toBe(true)
      expect(device.revokedAt).toBeNull()
    })

    it('returns 204 for non-existent device (idempotent)', async () => {
      const userId = p('revoke-nonexistent-user')
      const token = p('revoke-nonexistent-token')
      const callerDeviceId = p('caller-nonexist')
      await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertCanaryWithSecret(userId)

      const response = await app.handle(
        revokeRequest(p('does-not-exist'), token, {
          callerDeviceId,
          canarySecret: testCanarySecret,
        }),
      )

      expect(response.status).toBe(204)
    })

    it('returns 204 when revoking already-revoked device (preserves original revokedAt)', async () => {
      const userId = p('revoke-idempotent-user')
      const token = p('revoke-idempotent-token')
      const callerDeviceId = p('caller-idempotent')
      const deviceId = p('device-already-revoked')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertCanaryWithSecret(userId)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Already Revoked',
        lastSeen: now,
        createdAt: now,
        trusted: true,
      })

      // First revoke
      const firstResponse = await app.handle(
        revokeRequest(deviceId, token, {
          callerDeviceId,
          canarySecret: testCanarySecret,
        }),
      )
      expect(firstResponse.status).toBe(204)

      const [afterFirst] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      const originalRevokedAt = afterFirst.revokedAt

      // Second revoke — no-op because isNull(revokedAt) guard skips already-revoked devices
      const response = await app.handle(
        revokeRequest(deviceId, token, {
          callerDeviceId,
          canarySecret: testCanarySecret,
        }),
      )

      expect(response.status).toBe(204)

      // Original revokedAt timestamp is preserved
      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).toEqual(originalRevokedAt)
    })

    it('handles device with no envelope gracefully', async () => {
      const userId = p('revoke-no-envelope-user')
      const token = p('revoke-no-envelope-token')
      const callerDeviceId = p('caller-no-envelope')
      const deviceId = p('device-no-envelope')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertCanaryWithSecret(userId)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Pending Device',
        lastSeen: now,
        createdAt: now,
        trusted: false,
      })

      const response = await app.handle(
        revokeRequest(deviceId, token, {
          callerDeviceId,
          canarySecret: testCanarySecret,
        }),
      )

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).not.toBeNull()

      const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, deviceId))
      expect(envelopes).toHaveLength(0)
    })

    it('prevents full attack chain: stolen session cannot revoke devices to reset E2EE state', async () => {
      // Setup: user with 2 trusted devices, both with envelopes, E2EE fully active
      const userId = p('attack-chain-user')
      const token = p('attack-chain-token')
      const attackerDeviceId = p('attacker-device')
      const victimDevice1 = p('victim-device-1')
      const victimDevice2 = p('victim-device-2')
      const now = await createUserSessionAndDevice(userId, token, victimDevice1)
      await insertCanaryWithSecret(userId)

      await db.insert(devicesTable).values({
        id: victimDevice2,
        userId,
        name: 'Victim Device 2',
        trusted: true,
        lastSeen: now,
        createdAt: now,
      })

      await db.insert(envelopesTable).values([
        { deviceId: victimDevice1, userId, wrappedCk: 'victim-ck-1', updatedAt: now },
        { deviceId: victimDevice2, userId, wrappedCk: 'victim-ck-2', updatedAt: now },
      ])

      // Attack step 1: Try to revoke device 1 without canary proof
      const attack1 = await app.handle(revokeRequest(victimDevice1, token, { callerDeviceId: victimDevice1 }))
      expect(attack1.status).toBe(403)

      // Attack step 2: Try to revoke device 2 with a guessed canary
      const attack2 = await app.handle(
        revokeRequest(victimDevice2, token, {
          callerDeviceId: victimDevice1,
          canarySecret: 'attacker-guess',
        }),
      )
      expect(attack2.status).toBe(403)

      // Attack step 3: Try from an untrusted attacker device
      await db.insert(devicesTable).values({
        id: attackerDeviceId,
        userId,
        name: 'Attacker Device',
        trusted: false,
        lastSeen: now,
        createdAt: now,
      })
      const attack3 = await app.handle(
        revokeRequest(victimDevice1, token, {
          callerDeviceId: attackerDeviceId,
          canarySecret: testCanarySecret,
        }),
      )
      expect(attack3.status).toBe(403)

      // Verify: both envelopes still intact, both devices still trusted
      const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.userId, userId))
      expect(envelopes).toHaveLength(2)

      const [d1] = await db.select().from(devicesTable).where(eq(devicesTable.id, victimDevice1))
      expect(d1.trusted).toBe(true)
      expect(d1.revokedAt).toBeNull()

      const [d2] = await db.select().from(devicesTable).where(eq(devicesTable.id, victimDevice2))
      expect(d2.trusted).toBe(true)
      expect(d2.revokedAt).toBeNull()
    })

    it('returns 204 without canarySecret for pre-encryption user (no E2EE metadata)', async () => {
      const userId = p('pre-enc-user')
      const token = p('pre-enc-token')
      const callerDeviceId = p('caller-pre-enc')
      const deviceId = p('device-pre-enc')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)

      // No encryption metadata inserted — pre-encryption user

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Pre-encryption Device',
        lastSeen: now,
        createdAt: now,
        trusted: false,
      })

      const response = await app.handle(revokeRequest(deviceId, token, { callerDeviceId }))

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).not.toBeNull()
    })
  })
})
