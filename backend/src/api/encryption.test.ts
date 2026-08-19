/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { encryptionMetadataTable, envelopesTable } from '@/db/encryption-schema'
import { devicesTable } from '@/db/schema'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createEncryptionRoutes } from './encryption'

const baseUrl = 'http://localhost'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'
const signToken = (token: string): string => {
  const sig = createHmac('sha256', betterAuthSecret).update(token).digest('base64')
  return `${token}.${sig}`
}

/**
 * Unique-ID strategy for PGlite + nested transactions:
 *
 * Tests use createTestDb() which wraps each test in BEGIN / ROLLBACK for isolation.
 * However, some endpoints (e.g. POST /devices/:id/envelope, POST /devices/:id/revoke)
 * call database.transaction() internally. In PGlite's single-connection model, the
 * inner BEGIN is treated as a no-op and the inner COMMIT commits the *outer* test
 * transaction, so ROLLBACK in afterEach becomes a no-op and inserted rows persist.
 *
 * CI runs every test file 5× in the same process (test:backend:5x). Without unique IDs
 * the second run hits unique-constraint violations on user/device/session rows left
 * behind by the first run.
 *
 * Fix: p() prefixes every ID with a globalThis counter that survives module re-evaluation
 * (bun's --rerun-each reloads the module, resetting module-scope variables).
 */
const counterKey = Symbol.for('encryption-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

describe('Encryption API', () => {
  let app: ReturnType<typeof createEncryptionRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  /** Prefix IDs with the current runId — see top-of-file comment for why. */
  let p: (id: string) => string

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 3600 * 1000)

  const createUserAndSession = async (
    userId: string,
    token: string,
    email = `${userId}@test.com`,
    deviceId?: string,
  ) => {
    await db.insert(userTable).values({
      id: userId,
      name: 'Test User',
      email,
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
      ...(deviceId ? { deviceId } : {}),
    })
  }

  const insertDevice = async (
    id: string,
    userId: string,
    options: {
      trusted?: boolean
      approvalPending?: boolean
      publicKey?: string
      mlkemPublicKey?: string
      revokedAt?: Date
    } = {},
  ) => {
    const {
      trusted = false,
      // Mirror production semantics: trusted devices are not approval-pending. Tests that
      // need the illegal `(trusted=true, approvalPending=true)` state must pass it explicitly.
      approvalPending = !trusted,
      publicKey = 'pk-test',
      mlkemPublicKey = 'mlkem-pk-test',
      revokedAt,
    } = options
    await db.insert(devicesTable).values({
      id,
      userId,
      name: 'Test Device',
      trusted,
      approvalPending,
      publicKey,
      mlkemPublicKey,
      lastSeen: now,
      createdAt: now,
      ...(revokedAt ? { revokedAt } : {}),
    })
  }

  const insertEnvelope = async (deviceId: string, userId: string, wrappedCk = 'wrapped-ck') => {
    await db.insert(envelopesTable).values({
      deviceId,
      userId,
      wrappedCk,
      createdAt: now,
      updatedAt: now,
    })
  }

  const insertCanary = async (userId: string, canaryIv = 'iv-test', canaryCtext = 'ctext-test') => {
    await db.insert(encryptionMetadataTable).values({
      userId,
      canaryIv,
      canaryCtext,
      createdAt: now,
    })
  }

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `${rid}-${id}`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const auth = createAuth(db)
    app = new Elysia().use(createEncryptionRoutes(auth, createTestSettings(), db)) as unknown as ReturnType<
      typeof createEncryptionRoutes
    >
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  // ─── POST /devices ──────────────────────────────────────────────────

  describe('POST /devices', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk', mlkemPublicKey: 'mlkem-pk' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 401 with invalid token', async () => {
      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer invalid-token',
          },
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk', mlkemPublicKey: 'mlkem-pk' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('registers new device as untrusted', async () => {
      await createUserAndSession(p('u1'), p('tok-u1'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u1'))}`,
          },
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk1', mlkemPublicKey: 'mlkem-pk1', name: 'My Device' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(false)

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d1')))
      expect(device).toBeDefined()
      expect(device.userId).toBe(p('u1'))
      expect(device.name).toBe('My Device')
      expect(device.trusted).toBe(false)
    })

    it('registers new device as untrusted when envelopes exist', async () => {
      await createUserAndSession(p('u2'), p('tok-u2'))
      await insertDevice(p('d-existing'), p('u2'), { trusted: true })
      await insertEnvelope(p('d-existing'), p('u2'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u2'))}`,
          },
          body: JSON.stringify({ deviceId: p('d-new'), publicKey: 'pk2', mlkemPublicKey: 'mlkem-pk2' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(false)
    })

    it('returns trusted with envelope for already-trusted device', async () => {
      await createUserAndSession(p('u3'), p('tok-u3'))
      await insertDevice(p('d-trusted'), p('u3'), { trusted: true })
      await insertEnvelope(p('d-trusted'), p('u3'), 'my-wrapped-ck')

      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u3'))}`,
          },
          body: JSON.stringify({ deviceId: p('d-trusted'), publicKey: 'pk3', mlkemPublicKey: 'mlkem-pk3' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(true)
      expect(body.envelope).toBe('my-wrapped-ck')
    })

    it('returns untrusted for already-pending device', async () => {
      await createUserAndSession(p('u4'), p('tok-u4'))
      await insertDevice(p('d-pending'), p('u4'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u4'))}`,
          },
          body: JSON.stringify({ deviceId: p('d-pending'), publicKey: 'pk4', mlkemPublicKey: 'mlkem-pk4' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(false)
    })

    it('returns 409 when deviceId belongs to different user', async () => {
      await createUserAndSession(p('u5a'), p('tok-u5a'), `${p('u5a')}@test.com`)
      await createUserAndSession(p('u5b'), p('tok-u5b'), `${p('u5b')}@test.com`)
      await insertDevice(p('d-conflict'), p('u5a'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u5b'))}`,
          },
          body: JSON.stringify({ deviceId: p('d-conflict'), publicKey: 'pk5', mlkemPublicKey: 'mlkem-pk5' }),
        }),
      )

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('Device ID already taken')
    })

    it('returns 403 when re-registering a revoked device', async () => {
      await createUserAndSession(p('u6'), p('tok-u6'))
      await insertDevice(p('d-revoked'), p('u6'), { revokedAt: now })

      const response = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u6'))}`,
          },
          body: JSON.stringify({ deviceId: p('d-revoked'), publicKey: 'pk6', mlkemPublicKey: 'mlkem-pk6' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Device has been revoked')
    })

    it('uses "Unknown device" for empty or >100 char name', async () => {
      await createUserAndSession(p('u7'), p('tok-u7'))

      // Empty name
      await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u7'))}`,
          },
          body: JSON.stringify({
            deviceId: p('d-empty-name'),
            publicKey: 'pk7a',
            mlkemPublicKey: 'mlkem-pk7a',
            name: '',
          }),
        }),
      )

      const [deviceEmpty] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-empty-name')))
      expect(deviceEmpty.name).toBe('Unknown device')

      // Name > 100 chars — rejected by Elysia schema validation (maxLength: 100)
      const longNameResponse = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-u7'))}`,
          },
          body: JSON.stringify({
            deviceId: p('d-long-name'),
            publicKey: 'pk7b',
            mlkemPublicKey: 'mlkem-pk7b',
            name: 'x'.repeat(101),
          }),
        }),
      )
      expect(longNameResponse.status).toBe(422)
    })
  })

  // ─── GET /devices/me/envelope ───────────────────────────────────────

  describe('GET /devices/me/envelope', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(new Request(`${baseUrl}/devices/me/envelope`))
      expect(response.status).toBe(401)
    })

    it('returns 400 when X-Device-ID missing', async () => {
      await createUserAndSession(p('u-me1'), p('tok-me1'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/me/envelope`, {
          headers: { Authorization: `Bearer ${signToken(p('tok-me1'))}` },
        }),
      )

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('X-Device-ID header is required')
    })

    it('returns envelope for trusted device', async () => {
      await createUserAndSession(p('u-me2'), p('tok-me2'))
      await insertDevice(p('d-me2'), p('u-me2'), { trusted: true })
      await insertEnvelope(p('d-me2'), p('u-me2'), 'my-wrapped-ck')

      const response = await app.handle(
        new Request(`${baseUrl}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${signToken(p('tok-me2'))}`,
            'X-Device-ID': p('d-me2'),
          },
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(true)
      expect(body.wrappedCK).toBe('my-wrapped-ck')
    })

    it('returns 404 when device belongs to different user', async () => {
      await createUserAndSession(p('u-me3a'), p('tok-me3a'), `${p('me3a')}@test.com`)
      await createUserAndSession(p('u-me3b'), p('tok-me3b'), `${p('me3b')}@test.com`)
      await insertDevice(p('d-me3'), p('u-me3b'), { trusted: true })
      await insertEnvelope(p('d-me3'), p('u-me3b'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${signToken(p('tok-me3a'))}`,
            'X-Device-ID': p('d-me3'),
          },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Device not found')
    })

    it('returns 403 when device is revoked', async () => {
      await createUserAndSession(p('u-me4'), p('tok-me4'))
      await insertDevice(p('d-me4'), p('u-me4'), { revokedAt: now })

      const response = await app.handle(
        new Request(`${baseUrl}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${signToken(p('tok-me4'))}`,
            'X-Device-ID': p('d-me4'),
          },
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Device has been revoked')
    })

    it('returns 404 when device has no envelope (pending device)', async () => {
      await createUserAndSession(p('u-me5'), p('tok-me5'))
      await insertDevice(p('d-me5'), p('u-me5'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${signToken(p('tok-me5'))}`,
            'X-Device-ID': p('d-me5'),
          },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Envelope not found')
    })

    it('returns 404 when deviceId does not exist', async () => {
      await createUserAndSession(p('u-me6'), p('tok-me6'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${signToken(p('tok-me6'))}`,
            'X-Device-ID': p('d-ghost'),
          },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Device not found')
    })
  })

  // ─── GET /encryption/canary ─────────────────────────────────────────

  describe('GET /encryption/canary', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(new Request(`${baseUrl}/encryption/canary`))
      expect(response.status).toBe(401)
    })

    it('returns canary when set up', async () => {
      await createUserAndSession(p('u-can1'), p('tok-can1'))
      await insertCanary(p('u-can1'), 'stored-iv', 'stored-ctext')

      const response = await app.handle(
        new Request(`${baseUrl}/encryption/canary`, {
          headers: { Authorization: `Bearer ${signToken(p('tok-can1'))}` },
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.canary_iv).toBe('stored-iv')
      expect(body.canary_ctext).toBe('stored-ctext')
      // v2 metadata fields ride along on the same poll (defaults for a bare canary row).
      expect(body.scheme_version).toBe(1)
      expect(body.primary_key_id).toBe('0')
      expect(body.key_version).toBe(1)
      expect(body.signing_public_key).toBeNull()
      expect(body.kdf_salt).toBeNull()
    })

    it('returns 404 when encryption not set up', async () => {
      await createUserAndSession(p('u-can2'), p('tok-can2'))

      const response = await app.handle(
        new Request(`${baseUrl}/encryption/canary`, {
          headers: { Authorization: `Bearer ${signToken(p('tok-can2'))}` },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Encryption not set up')
    })
  })

  // ─── POST /devices/me/node-id (self-enroll) ─────────────────────────

  describe('POST /devices/me/node-id (self-enroll)', () => {
    const nodeId = 'k51qzi5uqu5dh-self-enroll'

    const selfEnroll = (token: string, callerDeviceId: string | undefined, body: object) =>
      app.handle(
        new Request(`${baseUrl}/devices/me/node-id`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(token)}`,
            ...(callerDeviceId ? { 'X-Device-ID': callerDeviceId } : {}),
          },
          body: JSON.stringify(body),
        }),
      )

    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request(`${baseUrl}/devices/me/node-id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Device-ID': p('d-se') },
          body: JSON.stringify({ nodeId }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 400 when X-Device-ID header missing', async () => {
      await createUserAndSession(p('u-se-nohdr'), p('tok-se-nohdr'), undefined, p('d-se-nohdr'))
      await insertDevice(p('d-se-nohdr'), p('u-se-nohdr'), { trusted: true })

      const response = await selfEnroll(p('tok-se-nohdr'), undefined, { nodeId })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('X-Device-ID header is required')
    })

    it('rejects with 422 when nodeId missing (body validation)', async () => {
      await createUserAndSession(p('u-se-noid'), p('tok-se-noid'), undefined, p('d-se-noid'))
      await insertDevice(p('d-se-noid'), p('u-se-noid'), { trusted: true })

      const response = await selfEnroll(p('tok-se-noid'), p('d-se-noid'), {})
      expect(response.status).toBe(422)
    })

    it("writes the caller's own node_id when X-Device-ID matches the session device", async () => {
      await createUserAndSession(p('u-se-ok'), p('tok-se-ok'), undefined, p('d-se-ok'))
      await insertDevice(p('d-se-ok'), p('u-se-ok'), { trusted: true })

      const response = await selfEnroll(p('tok-se-ok'), p('d-se-ok'), { nodeId })
      expect(response.status).toBe(200)
      expect((await response.json()).nodeId).toBe(nodeId)

      const [row] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-se-ok')))
      expect(row.nodeId).toBe(nodeId)
      expect(row.nodeIdAttestedAt).not.toBeNull()
    })

    it('self-enrolls a pending device (not yet trusted) — harmless, allowlist only surfaces trusted', async () => {
      await createUserAndSession(p('u-se-pending'), p('tok-se-pending'), undefined, p('d-se-pending'))
      await insertDevice(p('d-se-pending'), p('u-se-pending')) // pending, not trusted

      const response = await selfEnroll(p('tok-se-pending'), p('d-se-pending'), { nodeId })
      expect(response.status).toBe(200)

      const [row] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-se-pending')))
      expect(row.nodeId).toBe(nodeId)
    })

    it("rejects writing another same-account device's node_id (X-Device-ID != session device)", async () => {
      // Session is bound to the caller's own device, but X-Device-ID targets a sibling device.
      await createUserAndSession(p('u-se-other'), p('tok-se-other'), undefined, p('d-se-self'))
      await insertDevice(p('d-se-self'), p('u-se-other'), { trusted: true })
      await insertDevice(p('d-se-victim'), p('u-se-other'), { trusted: true })

      const response = await selfEnroll(p('tok-se-other'), p('d-se-victim'), { nodeId })
      expect(response.status).toBe(403)
      expect((await response.json()).error).toBe('X-Device-ID does not match the authenticated device')

      // The victim device's node_id must be untouched.
      const [victim] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-se-victim')))
      expect(victim.nodeId).toBeNull()
    })

    it('rejects when the session is not linked to any device', async () => {
      await createUserAndSession(p('u-se-unlinked'), p('tok-se-unlinked')) // no session.deviceId
      await insertDevice(p('d-se-unlinked'), p('u-se-unlinked'), { trusted: true })

      const response = await selfEnroll(p('tok-se-unlinked'), p('d-se-unlinked'), { nodeId })
      expect(response.status).toBe(403)
      expect((await response.json()).error).toBe('X-Device-ID does not match the authenticated device')
    })

    it('returns 404 when the caller device is revoked (setDeviceNodeId matches 0 rows)', async () => {
      await createUserAndSession(p('u-se-revoked'), p('tok-se-revoked'), undefined, p('d-se-revoked'))
      await insertDevice(p('d-se-revoked'), p('u-se-revoked'), { trusted: true, revokedAt: now })

      const response = await selfEnroll(p('tok-se-revoked'), p('d-se-revoked'), { nodeId })
      expect(response.status).toBe(404)
      expect((await response.json()).error).toBe('Device not found')
    })
  })

  // ─── GET /devices/allowlist ─────────────────────────────────────────

  describe('GET /devices/allowlist', () => {
    const getAllowlist = (token: string) =>
      app.handle(
        new Request(`${baseUrl}/devices/allowlist`, {
          headers: { Authorization: `Bearer ${signToken(token)}` },
        }),
      )

    const insertDeviceWithNode = async (
      id: string,
      userId: string,
      nodeId: string | null,
      options: {
        trusted?: boolean
        approvalPending?: boolean
        revokedAt?: Date
        deviceType?: 'normal' | 'bridge'
      } = {},
    ) => {
      const { trusted = true, approvalPending = !trusted, revokedAt, deviceType = 'normal' } = options
      await db.insert(devicesTable).values({
        id,
        userId,
        name: 'Node Device',
        trusted,
        approvalPending,
        deviceType,
        lastSeen: now,
        createdAt: now,
        ...(nodeId ? { nodeId, nodeIdAttestedAt: now } : {}),
        ...(revokedAt ? { revokedAt } : {}),
      })
    }

    it('returns 401 without auth', async () => {
      const response = await app.handle(new Request(`${baseUrl}/devices/allowlist`))
      expect(response.status).toBe(401)
    })

    it('returns only trusted, non-revoked, non-null node_ids for the caller account', async () => {
      await createUserAndSession(p('u-al'), p('tok-al'))
      await insertDeviceWithNode(p('al-trusted'), p('u-al'), 'node-trusted', { deviceType: 'normal' })
      await insertDeviceWithNode(p('al-bridge'), p('u-al'), 'node-bridge', { deviceType: 'bridge' })
      // Excluded: pending (untrusted), revoked, trusted-but-no-node_id.
      await insertDeviceWithNode(p('al-pending'), p('u-al'), 'node-pending', { trusted: false })
      await insertDeviceWithNode(p('al-revoked'), p('u-al'), 'node-revoked', { trusted: true, revokedAt: now })
      await insertDeviceWithNode(p('al-nonode'), p('u-al'), null, { trusted: true })

      const response = await getAllowlist(p('tok-al'))
      expect(response.status).toBe(200)
      const body = await response.json()
      const nodeIds = (body.nodeIds as Array<{ nodeId: string; deviceType: string }>).map((n) => n.nodeId).sort()
      expect(nodeIds).toEqual(['node-bridge', 'node-trusted'])

      const bridge = (body.nodeIds as Array<{ nodeId: string; deviceType: string }>).find(
        (n) => n.nodeId === 'node-bridge',
      )
      expect(bridge?.deviceType).toBe('bridge')
    })

    it("excludes a denied device's node_id (trusted=false, approvalPending=false)", async () => {
      await createUserAndSession(p('u-al-denied'), p('tok-al-denied'))
      await insertDeviceWithNode(p('al-denied'), p('u-al-denied'), 'node-denied', {
        trusted: false,
        approvalPending: false,
      })

      const response = await getAllowlist(p('tok-al-denied'))
      expect(response.status).toBe(200)
      expect((await response.json()).nodeIds).toEqual([])
    })

    it('never leaks another account rows', async () => {
      await createUserAndSession(p('u-al-a'), p('tok-al-a'), `${p('al-a')}@test.com`)
      await createUserAndSession(p('u-al-b'), p('tok-al-b'), `${p('al-b')}@test.com`)
      await insertDeviceWithNode(p('al-mine'), p('u-al-a'), 'node-mine')
      await insertDeviceWithNode(p('al-theirs'), p('u-al-b'), 'node-theirs')

      const response = await getAllowlist(p('tok-al-a'))
      expect(response.status).toBe(200)
      const nodeIds = (await response.json()).nodeIds as Array<{ nodeId: string }>
      expect(nodeIds.map((n) => n.nodeId)).toEqual(['node-mine'])
    })

    it('returns an empty list when the account has no bound trusted devices', async () => {
      await createUserAndSession(p('u-al-empty'), p('tok-al-empty'))

      const response = await getAllowlist(p('tok-al-empty'))
      expect(response.status).toBe(200)
      expect((await response.json()).nodeIds).toEqual([])
    })
  })

  // ─── POST /devices/bridge (register bridge) ─────────────────────────

  describe('POST /devices/bridge', () => {
    const bridgeNodeId = 'k51qzi5uqu5dh-bridge-server'

    const registerBridge = (token: string, body: object) =>
      app.handle(
        new Request(`${baseUrl}/devices/bridge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signToken(token)}` },
          body: JSON.stringify(body),
        }),
      )

    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request(`${baseUrl}/devices/bridge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: bridgeNodeId }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('rejects with 422 when nodeId missing (body validation)', async () => {
      await createUserAndSession(p('u-br-noid'), p('tok-br-noid'))
      const response = await registerBridge(p('tok-br-noid'), { name: 'My Bridge' })
      expect(response.status).toBe(422)
    })

    it("registers a bridge as a trusted device_type='bridge' on the caller's account", async () => {
      await createUserAndSession(p('u-br-ok'), p('tok-br-ok'))

      const response = await registerBridge(p('tok-br-ok'), { nodeId: bridgeNodeId, name: 'My Bridge' })
      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.nodeId).toBe(bridgeNodeId)
      expect(json.deviceType).toBe('bridge')

      const [row] = await db.select().from(devicesTable).where(eq(devicesTable.id, json.id))
      expect(row.userId).toBe(p('u-br-ok'))
      expect(row.deviceType).toBe('bridge')
      expect(row.trusted).toBe(true)
      expect(row.approvalPending).toBe(false)
      expect(row.revokedAt).toBeNull()
      expect(row.nodeId).toBe(bridgeNodeId)
      expect(row.nodeIdAttestedAt).not.toBeNull()
      expect(row.name).toBe('My Bridge')
    })

    it('defaults the name to "Bridge" when omitted', async () => {
      await createUserAndSession(p('u-br-noname'), p('tok-br-noname'))
      const response = await registerBridge(p('tok-br-noname'), { nodeId: bridgeNodeId })
      expect(response.status).toBe(200)
      const [row] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, (await response.json()).id))
      expect(row.name).toBe('Bridge')
    })

    it('is idempotent on repeat add of the same bridge (no duplicate rows)', async () => {
      await createUserAndSession(p('u-br-idem'), p('tok-br-idem'))

      const first = await registerBridge(p('tok-br-idem'), { nodeId: bridgeNodeId, name: 'Bridge A' })
      const firstId = (await first.json()).id
      const second = await registerBridge(p('tok-br-idem'), { nodeId: bridgeNodeId, name: 'Bridge B' })
      const secondId = (await second.json()).id
      expect(secondId).toBe(firstId)

      const rows = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.userId, p('u-br-idem')))
      expect(rows.length).toBe(1)
      expect(rows[0].name).toBe('Bridge B')
    })

    it('refuses a new bridge when the account is at the device cap', async () => {
      await createUserAndSession(p('u-br-cap-new'), p('tok-br-cap-new'))
      for (let i = 0; i < 10; i++) {
        await insertDevice(p(`d-br-cap-new-${i}`), p('u-br-cap-new'), { trusted: true })
      }

      const response = await registerBridge(p('tok-br-cap-new'), { nodeId: bridgeNodeId })

      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ error: 'Device limit reached' })
    })

    it('allows re-registration of an existing bridge when the account is at the device cap', async () => {
      await createUserAndSession(p('u-br-cap-existing'), p('tok-br-cap-existing'))
      const first = await registerBridge(p('tok-br-cap-existing'), {
        nodeId: bridgeNodeId,
        name: 'Bridge A',
      })
      expect(first.status).toBe(200)
      const firstId = ((await first.json()) as { id: string }).id
      for (let i = 0; i < 9; i++) {
        await insertDevice(p(`d-br-cap-existing-${i}`), p('u-br-cap-existing'), { trusted: true })
      }

      const response = await registerBridge(p('tok-br-cap-existing'), {
        nodeId: bridgeNodeId,
        name: 'Bridge B',
      })

      expect(response.status).toBe(200)
      expect((await response.json()).id).toBe(firstId)
      const [row] = await db.select().from(devicesTable).where(eq(devicesTable.id, firstId))
      expect(row.name).toBe('Bridge B')
    })

    it('refuses to resurrect a revoked bridge (same NodeId) — stays revoked', async () => {
      await createUserAndSession(p('u-br-rev'), p('tok-br-rev'))

      const first = await registerBridge(p('tok-br-rev'), { nodeId: bridgeNodeId })
      const bridgeId = (await first.json()).id
      await db.update(devicesTable).set({ revokedAt: now, trusted: false }).where(eq(devicesTable.id, bridgeId))

      const response = await registerBridge(p('tok-br-rev'), { nodeId: bridgeNodeId })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'Bridge device revoked' })

      // The row must remain revoked and untrusted — revocation is not undone by a re-add.
      const [row] = await db.select().from(devicesTable).where(eq(devicesTable.id, bridgeId))
      expect(row.revokedAt).not.toBeNull()
      expect(row.trusted).toBe(false)
    })

    it('scopes the bridge row to the caller and never collides across accounts (same nodeId)', async () => {
      await createUserAndSession(p('u-br-a'), p('tok-br-a'), `${p('br-a')}@test.com`)
      await createUserAndSession(p('u-br-b'), p('tok-br-b'), `${p('br-b')}@test.com`)

      const a = await registerBridge(p('tok-br-a'), { nodeId: bridgeNodeId, name: 'A bridge' })
      const b = await registerBridge(p('tok-br-b'), { nodeId: bridgeNodeId, name: 'B bridge' })
      const aId = (await a.json()).id
      const bId = (await b.json()).id
      expect(aId).not.toBe(bId)

      const [aRow] = await db.select().from(devicesTable).where(eq(devicesTable.id, aId))
      const [bRow] = await db.select().from(devicesTable).where(eq(devicesTable.id, bId))
      expect(aRow.userId).toBe(p('u-br-a'))
      expect(aRow.name).toBe('A bridge')
      expect(bRow.userId).toBe(p('u-br-b'))
      expect(bRow.name).toBe('B bridge')
    })

    it("ignores any client-supplied deviceType and always sets 'bridge'", async () => {
      await createUserAndSession(p('u-br-spoof'), p('tok-br-spoof'))

      // deviceType is not part of the route body schema, so a client attempt is dropped by
      // validation-stripping and the server still fixes device_type='bridge'.
      const response = await registerBridge(p('tok-br-spoof'), { nodeId: bridgeNodeId, deviceType: 'normal' })
      expect(response.status).toBe(200)
      expect((await response.json()).deviceType).toBe('bridge')

      const [row] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.userId, p('u-br-spoof')))
      expect(row.deviceType).toBe('bridge')
    })
  })
})

const fullAppCounterKey = Symbol.for('encryption-full-app-test-runId')
;(globalThis as Record<symbol, number>)[fullAppCounterKey] ??= 0

describe('Bridge device lifecycle API through full app', () => {
  let fullApp: Awaited<ReturnType<typeof createApp>>
  let fullAppDb: Awaited<ReturnType<typeof createTestDb>>['db']
  let fullAppCleanup: () => Promise<void>
  /** Prefix persistent PGlite rows with a unique ID for randomized and repeated runs. */
  let testId: (id: string) => string

  const fullAppBaseUrl = `${baseUrl}/v1`
  const fullAppNow = new Date()
  const fullAppExpiresAt = new Date(fullAppNow.getTime() + 60 * 60 * 1000)

  /** Create an authenticated user session for full-app requests. */
  const createFullAppUserAndSession = async (label: string) => {
    const userId = testId(`user-${label}`)
    const token = testId(`token-${label}`)
    await fullAppDb.insert(userTable).values({
      id: userId,
      name: label,
      email: `${userId}@test.com`,
      emailVerified: true,
      createdAt: fullAppNow,
      updatedAt: fullAppNow,
    })
    await fullAppDb.insert(sessionTable).values({
      id: testId(`session-${label}`),
      token,
      userId,
      expiresAt: fullAppExpiresAt,
      createdAt: fullAppNow,
      updatedAt: fullAppNow,
    })
    return { userId, token }
  }

  /** Register a bridge through the production app route. */
  const registerFullAppBridge = (token: string, nodeId: string, name = 'Test Bridge') =>
    fullApp.handle(
      new Request(`${fullAppBaseUrl}/devices/bridge`, {
        method: 'POST',
        headers: { authorization: `Bearer ${signToken(token)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId, name }),
      }),
    )

  /** Revoke a device through the production account route. */
  const revokeFullAppDevice = (token: string, deviceId: string) =>
    fullApp.handle(
      new Request(`${fullAppBaseUrl}/account/devices/${deviceId}/revoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${signToken(token)}`,
          'content-type': 'application/json',
          'x-device-id': testId('caller-device'),
        },
        body: '{}',
      }),
    )

  /** Remove a device through the production encryption route. */
  const removeFullAppDevice = (token: string, deviceId: string) =>
    fullApp.handle(
      new Request(`${fullAppBaseUrl}/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${signToken(token)}` },
      }),
    )

  /** Insert a normal device for removal-eligibility and cap tests. */
  const insertFullAppNormalDevice = async (id: string, userId: string, revoked = false) => {
    await fullAppDb.insert(devicesTable).values({
      id,
      userId,
      name: id,
      trusted: !revoked,
      approvalPending: false,
      lastSeen: fullAppNow,
      createdAt: fullAppNow,
      ...(revoked ? { revokedAt: fullAppNow } : {}),
    })
  }

  beforeEach(async () => {
    const runId = ++(globalThis as Record<symbol, number>)[fullAppCounterKey]
    testId = (id: string) => `${runId}-${id}`
    const testEnv = await createTestDb()
    fullAppDb = testEnv.db
    fullAppCleanup = testEnv.cleanup
    fullApp = await createApp({ database: fullAppDb, auth: createAuth(fullAppDb) })
  })

  afterEach(async () => {
    await fullAppCleanup()
  })

  it('returns 409 when the same NodeId re-registers after revocation', async () => {
    const { token } = await createFullAppUserAndSession('revoked-register')
    const nodeId = testId('revoked-node')
    const registered = await registerFullAppBridge(token, nodeId)
    const bridgeId = ((await registered.json()) as { id: string }).id
    expect((await revokeFullAppDevice(token, bridgeId)).status).toBe(204)

    const response = await registerFullAppBridge(token, nodeId)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Bridge device revoked' })
  })

  it('removes a revoked bridge and its bound sessions, then permits re-registration', async () => {
    const { userId, token } = await createFullAppUserAndSession('remove-revoked')
    const nodeId = testId('removed-node')
    const registered = await registerFullAppBridge(token, nodeId)
    const bridgeId = ((await registered.json()) as { id: string }).id
    await fullAppDb
      .update(devicesTable)
      .set({ revokedAt: fullAppNow, trusted: false })
      .where(eq(devicesTable.id, bridgeId))
    await fullAppDb.insert(sessionTable).values({
      id: testId('bridge-session'),
      token: testId('bridge-session-token'),
      userId,
      deviceId: bridgeId,
      expiresAt: fullAppExpiresAt,
      createdAt: fullAppNow,
      updatedAt: fullAppNow,
    })

    const response = await removeFullAppDevice(token, bridgeId)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(await fullAppDb.select().from(devicesTable).where(eq(devicesTable.id, bridgeId))).toHaveLength(0)
    expect(await fullAppDb.select().from(sessionTable).where(eq(sessionTable.deviceId, bridgeId))).toHaveLength(0)
    expect((await registerFullAppBridge(token, nodeId)).status).toBe(200)
  })

  it('returns 409 for a non-revoked bridge', async () => {
    const { token } = await createFullAppUserAndSession('active-bridge')
    const registered = await registerFullAppBridge(token, testId('active-node'))
    const bridgeId = ((await registered.json()) as { id: string }).id

    const response = await removeFullAppDevice(token, bridgeId)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Only revoked bridge devices can be removed' })
  })

  it('returns 409 for normal devices whether active or revoked', async () => {
    const { userId, token } = await createFullAppUserAndSession('normal-devices')
    const activeId = testId('normal-active')
    const revokedId = testId('normal-revoked')
    await insertFullAppNormalDevice(activeId, userId)
    await insertFullAppNormalDevice(revokedId, userId, true)

    for (const deviceId of [activeId, revokedId]) {
      const response = await removeFullAppDevice(token, deviceId)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'Only revoked bridge devices can be removed' })
    }
  })

  it("returns 404 for another user's revoked bridge", async () => {
    const owner = await createFullAppUserAndSession('bridge-owner')
    const caller = await createFullAppUserAndSession('other-caller')
    const registered = await registerFullAppBridge(owner.token, testId('other-user-node'))
    const bridgeId = ((await registered.json()) as { id: string }).id
    await fullAppDb
      .update(devicesTable)
      .set({ revokedAt: fullAppNow, trusted: false })
      .where(eq(devicesTable.id, bridgeId))

    const response = await removeFullAppDevice(caller.token, bridgeId)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Device not found' })
  })

  it('preserves device-cap rejection and active bridge re-registration exemption', async () => {
    const capped = await createFullAppUserAndSession('capped-new')
    for (let index = 0; index < 10; index++) {
      await insertFullAppNormalDevice(testId(`capped-device-${index}`), capped.userId)
    }
    const atCap = await registerFullAppBridge(capped.token, testId('new-node-at-cap'))
    expect(atCap.status).toBe(422)
    expect(await atCap.json()).toEqual({ error: 'Device limit reached' })

    const exempt = await createFullAppUserAndSession('capped-existing')
    const nodeId = testId('existing-node-at-cap')
    const first = await registerFullAppBridge(exempt.token, nodeId, 'Original')
    const bridgeId = ((await first.json()) as { id: string }).id
    for (let index = 0; index < 9; index++) {
      await insertFullAppNormalDevice(testId(`exempt-device-${index}`), exempt.userId)
    }
    const repeated = await registerFullAppBridge(exempt.token, nodeId, 'Updated')
    expect(repeated.status).toBe(200)
    expect(((await repeated.json()) as { id: string }).id).toBe(bridgeId)
  })
})
