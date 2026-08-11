/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { issueChallengeNonce } from '@/dal'
import { session as sessionTable, user } from '@/db/auth-schema'
import { encryptionMetadataTable, envelopesTable } from '@/db/encryption-schema'
import { chatThreadsTable, devicesTable, settingsTable, tasksTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { exportSigningPublicKey, generateSigningKeypair, signChallenge } from '@/test-utils/e2ee'
import type { ChallengeProof } from '@shared/e2ee-types'
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

describe('Account API', () => {
  let app: ReturnType<typeof createAccountRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  /** Prefix IDs with the current runId — see top-of-file comment for why. */
  let p: (id: string) => string

  /** Account signing keypair — the test stand-in for the key clients derive from the canary secret. */
  let signingKeypair: CryptoKeyPair

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `${rid}-${id}`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    signingKeypair = await generateSigningKeypair()
    const auth = createAuth(db)
    app = new Elysia({ prefix: '/v1' }).use(createAccountRoutes(auth, db)) as unknown as ReturnType<
      typeof createAccountRoutes
    >
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

  /** Insert v2 encryption metadata whose signing key is the test keypair's public key. */
  const insertMetadata = async (userId: string, options: { v1?: boolean } = {}) => {
    const now = new Date()
    await db.insert(encryptionMetadataTable).values({
      userId,
      canaryIv: 'iv-test',
      canaryCtext: 'ctext-test',
      // v1 rows have neither a signing key nor a kdf salt
      signingPublicKey: options.v1 ? null : await exportSigningPublicKey(signingKeypair),
      kdfSalt: options.v1 ? null : 'kdf-salt-test',
      createdAt: now,
    })
  }

  /** Issue a 'revoke' nonce and sign it with the account signing key (or `signWith`). */
  const makeRevokeProof = async (
    userId: string,
    callerDeviceId: string,
    options: { signWith?: CryptoKey } = {},
  ): Promise<ChallengeProof> => {
    const { nonce } = await issueChallengeNonce(db, {
      userId,
      operation: 'revoke',
      deviceId: callerDeviceId,
      ttlMs: 60_000,
    })
    const signature = await signChallenge(
      options.signWith ?? signingKeypair.privateKey,
      nonce,
      'revoke',
      callerDeviceId,
    )
    return { signature, nonce, operation: 'revoke', deviceId: callerDeviceId }
  }

  /** Build a revoke request with proper headers and body. */
  const revokeRequest = (
    deviceId: string,
    token: string,
    opts?: { callerDeviceId?: string; proof?: ChallengeProof; omitDeviceHeader?: boolean },
  ) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${signToken(token)}`,
      'Content-Type': 'application/json',
    }
    if (!opts?.omitDeviceHeader && opts?.callerDeviceId) {
      headers['X-Device-ID'] = opts.callerDeviceId
    }
    const body = opts?.proof ? JSON.stringify({ proof: opts.proof }) : '{}'
    return new Request(`http://localhost/v1/account/devices/${deviceId}/revoke`, {
      method: 'POST',
      headers,
      body,
    })
  }

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

  describe('POST /v1/account/devices/:id/revoke (challenge proof)', () => {
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
      await insertMetadata(userId)

      const response = await app.handle(revokeRequest(p('some-device'), token, { omitDeviceHeader: true }))
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toContain('X-Device-ID')
    })

    it('returns 403 when proof is missing (E2EE v2 active)', async () => {
      const userId = p('no-proof-user')
      const token = p('no-proof-token')
      const callerDeviceId = p('caller-no-proof')
      await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertMetadata(userId)

      const response = await app.handle(revokeRequest(p('target-device'), token, { callerDeviceId }))
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toContain('Challenge proof required')
    })

    it('returns 403 when the proof is signed by the wrong key', async () => {
      const userId = p('bad-proof-user')
      const token = p('bad-proof-token')
      const callerDeviceId = p('caller-bad-proof')
      await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertMetadata(userId)
      const attackerKeypair = await generateSigningKeypair()
      const proof = await makeRevokeProof(userId, callerDeviceId, { signWith: attackerKeypair.privateKey })

      const response = await app.handle(revokeRequest(p('target-device'), token, { callerDeviceId, proof }))
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toContain('Invalid challenge proof')
    })

    it('returns 403 when caller device is not trusted', async () => {
      const userId = p('untrusted-caller-user')
      const token = p('untrusted-caller-token')
      const callerDeviceId = p('caller-untrusted')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertMetadata(userId)

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

      const proof = await makeRevokeProof(userId, callerDeviceId)
      const response = await app.handle(revokeRequest(targetDeviceId, token, { callerDeviceId, proof }))
      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toContain('Only trusted devices')
    })

    it('returns 204 and revokes device + deletes envelope (with challenge proof)', async () => {
      const userId = p('revoke-user')
      const token = p('revoke-token')
      const callerDeviceId = p('caller-revoke')
      const deviceId = p('device-to-revoke')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertMetadata(userId)

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

      const proof = await makeRevokeProof(userId, callerDeviceId)
      const response = await app.handle(revokeRequest(deviceId, token, { callerDeviceId, proof }))

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
      await insertMetadata(userId)

      const proof = await makeRevokeProof(userId, callerDeviceId)
      const response = await app.handle(revokeRequest(p('does-not-exist'), token, { callerDeviceId, proof }))

      expect(response.status).toBe(204)
    })

    it('returns 204 when revoking already-revoked device (preserves original revokedAt)', async () => {
      const userId = p('revoke-idempotent-user')
      const token = p('revoke-idempotent-token')
      const callerDeviceId = p('caller-idempotent')
      const deviceId = p('device-already-revoked')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertMetadata(userId)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Already Revoked',
        lastSeen: now,
        createdAt: now,
        trusted: true,
      })

      // First revoke — each attempt needs a fresh proof (nonces are single-use)
      const firstProof = await makeRevokeProof(userId, callerDeviceId)
      const firstResponse = await app.handle(revokeRequest(deviceId, token, { callerDeviceId, proof: firstProof }))
      expect(firstResponse.status).toBe(204)

      const [afterFirst] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      const originalRevokedAt = afterFirst.revokedAt

      // Second revoke — no-op because isNull(revokedAt) guard skips already-revoked devices
      const secondProof = await makeRevokeProof(userId, callerDeviceId)
      const response = await app.handle(revokeRequest(deviceId, token, { callerDeviceId, proof: secondProof }))

      expect(response.status).toBe(204)

      // Original revokedAt timestamp is preserved
      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).toEqual(originalRevokedAt)
    })

    it('rejects a replayed proof (nonce is single-use)', async () => {
      const userId = p('revoke-replay-user')
      const token = p('revoke-replay-token')
      const callerDeviceId = p('caller-replay')
      const deviceId = p('device-replay')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertMetadata(userId)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Replay Target',
        lastSeen: now,
        createdAt: now,
        trusted: true,
      })

      const proof = await makeRevokeProof(userId, callerDeviceId)
      const first = await app.handle(revokeRequest(deviceId, token, { callerDeviceId, proof }))
      expect(first.status).toBe(204)

      const second = await app.handle(revokeRequest(deviceId, token, { callerDeviceId, proof }))
      expect(second.status).toBe(403)
    })

    it('handles device with no envelope gracefully', async () => {
      const userId = p('revoke-no-envelope-user')
      const token = p('revoke-no-envelope-token')
      const callerDeviceId = p('caller-no-envelope')
      const deviceId = p('device-no-envelope')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      await insertMetadata(userId)

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'Pending Device',
        lastSeen: now,
        createdAt: now,
        trusted: false,
      })

      const proof = await makeRevokeProof(userId, callerDeviceId)
      const response = await app.handle(revokeRequest(deviceId, token, { callerDeviceId, proof }))

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).not.toBeNull()

      const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, deviceId))
      expect(envelopes).toHaveLength(0)
    })

    it('stolen session without a proof cannot revoke devices to reset E2EE state', async () => {
      // Attack: a session token alone (no signing key) must not be able to revoke.
      // The forged-proof and untrusted-caller variants are covered by the
      // dedicated 403 tests above — their in-transaction rejection rolls the
      // whole PGlite test transaction back (see top-of-file note), so this
      // test only exercises the fast-path (pre-transaction) rejection, which
      // leaves state observable.
      const userId = p('attack-chain-user')
      const token = p('attack-chain-token')
      const victimDevice1 = p('victim-device-1')
      const victimDevice2 = p('victim-device-2')
      const now = await createUserSessionAndDevice(userId, token, victimDevice1)
      await insertMetadata(userId)

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

      const attack = await app.handle(revokeRequest(victimDevice1, token, { callerDeviceId: victimDevice1 }))
      expect(attack.status).toBe(403)

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

    it('returns 204 without proof for pre-encryption user (no E2EE metadata)', async () => {
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

    it('returns 204 without proof for a v1 leftover (metadata with NULL signing key)', async () => {
      const userId = p('v1-leftover-user')
      const token = p('v1-leftover-token')
      const callerDeviceId = p('caller-v1-leftover')
      const deviceId = p('device-v1-leftover')
      const now = await createUserSessionAndDevice(userId, token, callerDeviceId)
      // v1 metadata: canary present, but no signing key — its proof mechanism no longer exists
      await insertMetadata(userId, { v1: true })

      await db.insert(devicesTable).values({
        id: deviceId,
        userId,
        name: 'v1 Device',
        lastSeen: now,
        createdAt: now,
        trusted: true,
      })

      const response = await app.handle(revokeRequest(deviceId, token, { callerDeviceId }))

      expect(response.status).toBe(204)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      expect(device.revokedAt).not.toBeNull()
    })
  })
})
