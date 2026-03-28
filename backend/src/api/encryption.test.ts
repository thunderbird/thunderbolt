import { createAuth } from '@/auth/auth'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { encryptionMetadataTable, envelopesTable } from '@/db/encryption-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createEncryptionRoutes } from './encryption'

const BASE = 'http://localhost'

describe('Encryption API', () => {
  let app: ReturnType<typeof createEncryptionRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 3600 * 1000)

  const createUserAndSession = async (userId: string, token: string, email = `${userId}@test.com`) => {
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
    })
  }

  const insertDevice = async (
    id: string,
    userId: string,
    status: 'APPROVAL_PENDING' | 'TRUSTED' | 'REVOKED' = 'APPROVAL_PENDING',
    publicKey = 'pk-test',
  ) => {
    await db.insert(devicesTable).values({
      id,
      userId,
      name: 'Test Device',
      status,
      publicKey,
      lastSeen: now,
      createdAt: now,
      ...(status === 'REVOKED' ? { revokedAt: now } : {}),
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
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const auth = createAuth(db)
    app = new Elysia().use(createEncryptionRoutes(auth, db)) as unknown as ReturnType<typeof createEncryptionRoutes>
  })

  afterEach(async () => {
    await cleanup()
  })

  // ─── POST /devices ──────────────────────────────────────────────────

  describe('POST /devices', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'd1', publicKey: 'pk' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 401 with invalid token', async () => {
      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer invalid-token',
          },
          body: JSON.stringify({ deviceId: 'd1', publicKey: 'pk' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('registers new device as APPROVAL_PENDING with firstDevice=true', async () => {
      await createUserAndSession('u1', 'tok-u1')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u1',
          },
          body: JSON.stringify({ deviceId: 'd1', publicKey: 'pk1', name: 'My Device' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('APPROVAL_PENDING')
      expect(body.firstDevice).toBe(true)

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd1'))
      expect(device).toBeDefined()
      expect(device.userId).toBe('u1')
      expect(device.name).toBe('My Device')
      expect(device.status).toBe('APPROVAL_PENDING')
    })

    it('registers new device as APPROVAL_PENDING with firstDevice=false when envelopes exist', async () => {
      await createUserAndSession('u2', 'tok-u2')
      await insertDevice('d-existing', 'u2', 'TRUSTED')
      await insertEnvelope('d-existing', 'u2')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u2',
          },
          body: JSON.stringify({ deviceId: 'd-new', publicKey: 'pk2' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('APPROVAL_PENDING')
      expect(body.firstDevice).toBe(false)
    })

    it('returns TRUSTED with envelope for already-trusted device', async () => {
      await createUserAndSession('u3', 'tok-u3')
      await insertDevice('d-trusted', 'u3', 'TRUSTED')
      await insertEnvelope('d-trusted', 'u3', 'my-wrapped-ck')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u3',
          },
          body: JSON.stringify({ deviceId: 'd-trusted', publicKey: 'pk3' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')
      expect(body.envelope).toBe('my-wrapped-ck')
    })

    it('returns APPROVAL_PENDING for already-pending device', async () => {
      await createUserAndSession('u4', 'tok-u4')
      await insertDevice('d-pending', 'u4', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u4',
          },
          body: JSON.stringify({ deviceId: 'd-pending', publicKey: 'pk4' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('APPROVAL_PENDING')
      expect(body.firstDevice).toBe(true)
    })

    it('returns 409 when deviceId belongs to different user', async () => {
      await createUserAndSession('u5a', 'tok-u5a', 'u5a@test.com')
      await createUserAndSession('u5b', 'tok-u5b', 'u5b@test.com')
      await insertDevice('d-conflict', 'u5a')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u5b',
          },
          body: JSON.stringify({ deviceId: 'd-conflict', publicKey: 'pk5' }),
        }),
      )

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('Device ID already taken')
    })

    it('returns 403 when re-registering a revoked device', async () => {
      await createUserAndSession('u6', 'tok-u6')
      await insertDevice('d-revoked', 'u6', 'REVOKED')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u6',
          },
          body: JSON.stringify({ deviceId: 'd-revoked', publicKey: 'pk6' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Device has been revoked')
    })

    it('uses "Unknown device" for empty or >100 char name', async () => {
      await createUserAndSession('u7', 'tok-u7')

      // Empty name
      await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u7',
          },
          body: JSON.stringify({ deviceId: 'd-empty-name', publicKey: 'pk7a', name: '' }),
        }),
      )

      const [deviceEmpty] = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd-empty-name'))
      expect(deviceEmpty.name).toBe('Unknown device')

      // Name > 100 chars
      await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-u7',
          },
          body: JSON.stringify({ deviceId: 'd-long-name', publicKey: 'pk7b', name: 'x'.repeat(101) }),
        }),
      )

      const [deviceLong] = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd-long-name'))
      expect(deviceLong.name).toBe('Unknown device')
    })
  })

  // ─── POST /devices/:deviceId/envelope ───────────────────────────────

  describe('POST /devices/:deviceId/envelope', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request(`${BASE}/devices/d1/envelope`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 400 when X-Device-ID header missing', async () => {
      await createUserAndSession('u-env1', 'tok-env1')
      await insertDevice('d-env1', 'u-env1')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-env1/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-env1',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('X-Device-ID header is required')
    })

    it('allows first-device bootstrap: pending device submits own envelope when no envelopes exist', async () => {
      await createUserAndSession('u-boot', 'tok-boot')
      await insertDevice('d-boot', 'u-boot', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-boot/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-boot',
            'X-Device-ID': 'd-boot',
          },
          body: JSON.stringify({ wrappedCK: 'wrapped-ck-boot' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd-boot'))
      expect(device.status).toBe('TRUSTED')

      const [envelope] = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, 'd-boot'))
      expect(envelope.wrappedCk).toBe('wrapped-ck-boot')
    })

    it('rejects pending device from approving itself when envelopes already exist', async () => {
      await createUserAndSession('u-self', 'tok-self')
      await insertDevice('d-trusted-existing', 'u-self', 'TRUSTED')
      await insertEnvelope('d-trusted-existing', 'u-self')
      await insertDevice('d-self', 'u-self', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-self/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-self',
            'X-Device-ID': 'd-self',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Only trusted devices can store envelopes')
    })

    it('rejects pending device from approving another pending device', async () => {
      await createUserAndSession('u-pp', 'tok-pp')
      // Need envelopes to exist so it's not first-device bootstrap
      await insertDevice('d-pp-trusted', 'u-pp', 'TRUSTED')
      await insertEnvelope('d-pp-trusted', 'u-pp')
      await insertDevice('d-pp-caller', 'u-pp', 'APPROVAL_PENDING')
      await insertDevice('d-pp-target', 'u-pp', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-pp-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-pp',
            'X-Device-ID': 'd-pp-caller',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Only trusted devices can store envelopes')
    })

    it('returns 404 when target device belongs to different user', async () => {
      await createUserAndSession('u-diff1', 'tok-diff1', 'diff1@test.com')
      await createUserAndSession('u-diff2', 'tok-diff2', 'diff2@test.com')
      await insertDevice('d-diff-caller', 'u-diff1', 'TRUSTED')
      await insertEnvelope('d-diff-caller', 'u-diff1')
      await insertDevice('d-diff-target', 'u-diff2', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-diff-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-diff1',
            'X-Device-ID': 'd-diff-caller',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Device not found')
    })

    it('returns 403 when caller device belongs to different user', async () => {
      await createUserAndSession('u-cdiff1', 'tok-cdiff1', 'cdiff1@test.com')
      await createUserAndSession('u-cdiff2', 'tok-cdiff2', 'cdiff2@test.com')
      await insertDevice('d-cdiff-target', 'u-cdiff1', 'APPROVAL_PENDING')
      await insertDevice('d-cdiff-caller', 'u-cdiff2', 'TRUSTED')
      await insertEnvelope('d-cdiff-caller', 'u-cdiff2')
      // Need envelopes for u-cdiff1 to avoid first-device bootstrap
      await insertDevice('d-cdiff-existing', 'u-cdiff1', 'TRUSTED')
      await insertEnvelope('d-cdiff-existing', 'u-cdiff1')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-cdiff-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-cdiff1',
            'X-Device-ID': 'd-cdiff-caller',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Caller device not found')
    })

    it('returns 403 when target device is revoked', async () => {
      await createUserAndSession('u-trev', 'tok-trev')
      await insertDevice('d-trev-caller', 'u-trev', 'TRUSTED')
      await insertEnvelope('d-trev-caller', 'u-trev')
      await insertDevice('d-trev-target', 'u-trev', 'REVOKED')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-trev-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-trev',
            'X-Device-ID': 'd-trev-caller',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Device has been revoked')
    })

    it('returns 403 when caller device is revoked', async () => {
      await createUserAndSession('u-crev', 'tok-crev')
      await insertDevice('d-crev-caller', 'u-crev', 'REVOKED')
      await insertDevice('d-crev-target', 'u-crev', 'APPROVAL_PENDING')
      // Need envelopes so it's not bootstrap
      await insertDevice('d-crev-existing', 'u-crev', 'TRUSTED')
      await insertEnvelope('d-crev-existing', 'u-crev')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-crev-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-crev',
            'X-Device-ID': 'd-crev-caller',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Only trusted devices can store envelopes')
    })

    it('returns 409 when overwriting trusted device envelope from another device', async () => {
      await createUserAndSession('u-ow', 'tok-ow')
      await insertDevice('d-ow-caller', 'u-ow', 'TRUSTED')
      await insertEnvelope('d-ow-caller', 'u-ow')
      await insertDevice('d-ow-target', 'u-ow', 'TRUSTED')
      await insertEnvelope('d-ow-target', 'u-ow')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-ow-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-ow',
            'X-Device-ID': 'd-ow-caller',
          },
          body: JSON.stringify({ wrappedCK: 'new-wck' }),
        }),
      )

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('Cannot overwrite envelope of an already-trusted device')
    })

    it('allows trusted device to re-key its own envelope', async () => {
      await createUserAndSession('u-rekey', 'tok-rekey')
      await insertDevice('d-rekey', 'u-rekey', 'TRUSTED')
      await insertEnvelope('d-rekey', 'u-rekey', 'old-wck')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-rekey/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-rekey',
            'X-Device-ID': 'd-rekey',
          },
          body: JSON.stringify({ wrappedCK: 'new-wck' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')

      const [envelope] = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, 'd-rekey'))
      expect(envelope.wrappedCk).toBe('new-wck')
    })

    it('returns 404 when target deviceId does not exist', async () => {
      await createUserAndSession('u-nodev', 'tok-nodev')
      await insertDevice('d-nodev-caller', 'u-nodev', 'TRUSTED')
      await insertEnvelope('d-nodev-caller', 'u-nodev')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-nonexistent/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-nodev',
            'X-Device-ID': 'd-nodev-caller',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Device not found')
    })

    it('returns 403 when caller deviceId does not exist (non-first-device scenario)', async () => {
      await createUserAndSession('u-nocaller', 'tok-nocaller')
      await insertDevice('d-nocaller-target', 'u-nocaller', 'APPROVAL_PENDING')
      // Need envelopes to exist
      await insertDevice('d-nocaller-existing', 'u-nocaller', 'TRUSTED')
      await insertEnvelope('d-nocaller-existing', 'u-nocaller')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-nocaller-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-nocaller',
            'X-Device-ID': 'd-ghost',
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Caller device not found')
    })

    it('allows trusted device to approve a pending device', async () => {
      await createUserAndSession('u-approve', 'tok-approve')
      await insertDevice('d-approve-caller', 'u-approve', 'TRUSTED')
      await insertEnvelope('d-approve-caller', 'u-approve')
      await insertDevice('d-approve-target', 'u-approve', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-approve-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-approve',
            'X-Device-ID': 'd-approve-caller',
          },
          body: JSON.stringify({ wrappedCK: 'target-wck' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')

      const [device] = await db.select().from(devicesTable).where(eq(devicesTable.id, 'd-approve-target'))
      expect(device.status).toBe('TRUSTED')

      const [envelope] = await db.select().from(envelopesTable).where(eq(envelopesTable.deviceId, 'd-approve-target'))
      expect(envelope.wrappedCk).toBe('target-wck')
    })

    it('stores canary on first-device bootstrap', async () => {
      await createUserAndSession('u-canary', 'tok-canary')
      await insertDevice('d-canary', 'u-canary', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-canary/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-canary',
            'X-Device-ID': 'd-canary',
          },
          body: JSON.stringify({
            wrappedCK: 'wck',
            canaryIv: 'my-iv',
            canaryCtext: 'my-ctext',
          }),
        }),
      )

      expect(response.status).toBe(200)

      const [metadata] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, 'u-canary'))
      expect(metadata).toBeDefined()
      expect(metadata.canaryIv).toBe('my-iv')
      expect(metadata.canaryCtext).toBe('my-ctext')
    })

    it('does not overwrite existing canary on subsequent envelope submissions', async () => {
      await createUserAndSession('u-noow', 'tok-noow')
      await insertDevice('d-noow-caller', 'u-noow', 'TRUSTED')
      await insertEnvelope('d-noow-caller', 'u-noow')
      await insertCanary('u-noow', 'original-iv', 'original-ctext')
      await insertDevice('d-noow-target', 'u-noow', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/d-noow-target/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tok-noow',
            'X-Device-ID': 'd-noow-caller',
          },
          body: JSON.stringify({
            wrappedCK: 'wck',
            canaryIv: 'new-iv',
            canaryCtext: 'new-ctext',
          }),
        }),
      )

      expect(response.status).toBe(200)

      const [metadata] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, 'u-noow'))
      expect(metadata.canaryIv).toBe('original-iv')
      expect(metadata.canaryCtext).toBe('original-ctext')
    })
  })

  // ─── GET /devices/me/envelope ───────────────────────────────────────

  describe('GET /devices/me/envelope', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(new Request(`${BASE}/devices/me/envelope`))
      expect(response.status).toBe(401)
    })

    it('returns 400 when X-Device-ID missing', async () => {
      await createUserAndSession('u-me1', 'tok-me1')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: { Authorization: 'Bearer tok-me1' },
        }),
      )

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('X-Device-ID header is required')
    })

    it('returns envelope for trusted device', async () => {
      await createUserAndSession('u-me2', 'tok-me2')
      await insertDevice('d-me2', 'u-me2', 'TRUSTED')
      await insertEnvelope('d-me2', 'u-me2', 'my-wrapped-ck')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: 'Bearer tok-me2',
            'X-Device-ID': 'd-me2',
          },
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')
      expect(body.wrappedCK).toBe('my-wrapped-ck')
    })

    it('returns 404 when device belongs to different user', async () => {
      await createUserAndSession('u-me3a', 'tok-me3a', 'me3a@test.com')
      await createUserAndSession('u-me3b', 'tok-me3b', 'me3b@test.com')
      await insertDevice('d-me3', 'u-me3b', 'TRUSTED')
      await insertEnvelope('d-me3', 'u-me3b')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: 'Bearer tok-me3a',
            'X-Device-ID': 'd-me3',
          },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Device not found')
    })

    it('returns 403 when device is revoked', async () => {
      await createUserAndSession('u-me4', 'tok-me4')
      await insertDevice('d-me4', 'u-me4', 'REVOKED')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: 'Bearer tok-me4',
            'X-Device-ID': 'd-me4',
          },
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Device has been revoked')
    })

    it('returns 404 when device has no envelope (pending device)', async () => {
      await createUserAndSession('u-me5', 'tok-me5')
      await insertDevice('d-me5', 'u-me5', 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: 'Bearer tok-me5',
            'X-Device-ID': 'd-me5',
          },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Envelope not found')
    })

    it('returns 404 when deviceId does not exist', async () => {
      await createUserAndSession('u-me6', 'tok-me6')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: 'Bearer tok-me6',
            'X-Device-ID': 'd-ghost',
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
      const response = await app.handle(new Request(`${BASE}/encryption/canary`))
      expect(response.status).toBe(401)
    })

    it('returns canary when set up', async () => {
      await createUserAndSession('u-can1', 'tok-can1')
      await insertCanary('u-can1', 'stored-iv', 'stored-ctext')

      const response = await app.handle(
        new Request(`${BASE}/encryption/canary`, {
          headers: { Authorization: 'Bearer tok-can1' },
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.canaryIv).toBe('stored-iv')
      expect(body.canaryCtext).toBe('stored-ctext')
    })

    it('returns 404 when encryption not set up', async () => {
      await createUserAndSession('u-can2', 'tok-can2')

      const response = await app.handle(
        new Request(`${BASE}/encryption/canary`, {
          headers: { Authorization: 'Bearer tok-can2' },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Encryption not set up')
    })
  })
})
