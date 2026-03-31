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
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `${rid}-${id}`
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
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk' }),
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
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('registers new device as APPROVAL_PENDING with firstDevice=true', async () => {
      await createUserAndSession(p('u1'), p('tok-u1'))

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u1')}`,
          },
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk1', name: 'My Device' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('APPROVAL_PENDING')
      expect(body.firstDevice).toBe(true)

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d1')))
      expect(device).toBeDefined()
      expect(device.userId).toBe(p('u1'))
      expect(device.name).toBe('My Device')
      expect(device.status).toBe('APPROVAL_PENDING')
    })

    it('registers new device as APPROVAL_PENDING with firstDevice=false when envelopes exist', async () => {
      await createUserAndSession(p('u2'), p('tok-u2'))
      await insertDevice(p('d-existing'), p('u2'), 'TRUSTED')
      await insertEnvelope(p('d-existing'), p('u2'))

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u2')}`,
          },
          body: JSON.stringify({ deviceId: p('d-new'), publicKey: 'pk2' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('APPROVAL_PENDING')
      expect(body.firstDevice).toBe(false)
    })

    it('returns TRUSTED with envelope for already-trusted device', async () => {
      await createUserAndSession(p('u3'), p('tok-u3'))
      await insertDevice(p('d-trusted'), p('u3'), 'TRUSTED')
      await insertEnvelope(p('d-trusted'), p('u3'), 'my-wrapped-ck')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u3')}`,
          },
          body: JSON.stringify({ deviceId: p('d-trusted'), publicKey: 'pk3' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')
      expect(body.envelope).toBe('my-wrapped-ck')
    })

    it('returns APPROVAL_PENDING for already-pending device', async () => {
      await createUserAndSession(p('u4'), p('tok-u4'))
      await insertDevice(p('d-pending'), p('u4'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u4')}`,
          },
          body: JSON.stringify({ deviceId: p('d-pending'), publicKey: 'pk4' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('APPROVAL_PENDING')
      expect(body.firstDevice).toBe(true)
    })

    it('returns 409 when deviceId belongs to different user', async () => {
      await createUserAndSession(p('u5a'), p('tok-u5a'), `${p('u5a')}@test.com`)
      await createUserAndSession(p('u5b'), p('tok-u5b'), `${p('u5b')}@test.com`)
      await insertDevice(p('d-conflict'), p('u5a'))

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u5b')}`,
          },
          body: JSON.stringify({ deviceId: p('d-conflict'), publicKey: 'pk5' }),
        }),
      )

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('Device ID already taken')
    })

    it('returns 403 when re-registering a revoked device', async () => {
      await createUserAndSession(p('u6'), p('tok-u6'))
      await insertDevice(p('d-revoked'), p('u6'), 'REVOKED')

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u6')}`,
          },
          body: JSON.stringify({ deviceId: p('d-revoked'), publicKey: 'pk6' }),
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
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u7')}`,
          },
          body: JSON.stringify({ deviceId: p('d-empty-name'), publicKey: 'pk7a', name: '' }),
        }),
      )

      const [deviceEmpty] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-empty-name')))
      expect(deviceEmpty.name).toBe('Unknown device')

      // Name > 100 chars
      await app.handle(
        new Request(`${BASE}/devices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-u7')}`,
          },
          body: JSON.stringify({ deviceId: p('d-long-name'), publicKey: 'pk7b', name: 'x'.repeat(101) }),
        }),
      )

      const [deviceLong] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-long-name')))
      expect(deviceLong.name).toBe('Unknown device')
    })
  })

  // ─── POST /devices/:deviceId/envelope ───────────────────────────────

  describe('POST /devices/:deviceId/envelope', () => {
    it('returns 401 without auth', async () => {
      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d1')}/envelope`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('returns 400 when X-Device-ID header missing', async () => {
      await createUserAndSession(p('u-env1'), p('tok-env1'))
      await insertDevice(p('d-env1'), p('u-env1'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-env1')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-env1')}`,
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('X-Device-ID header is required')
    })

    it('allows first-device bootstrap: pending device submits own envelope when no envelopes exist', async () => {
      await createUserAndSession(p('u-boot'), p('tok-boot'))
      await insertDevice(p('d-boot'), p('u-boot'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-boot')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-boot')}`,
            'X-Device-ID': p('d-boot'),
          },
          body: JSON.stringify({ wrappedCK: 'wrapped-ck-boot' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-boot')))
      expect(device.status).toBe('TRUSTED')

      const [envelope] = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.deviceId, p('d-boot')))
      expect(envelope.wrappedCk).toBe('wrapped-ck-boot')
    })

    it('rejects pending device from approving itself when envelopes already exist (no canary match)', async () => {
      await createUserAndSession(p('u-self'), p('tok-self'))
      await insertDevice(p('d-trusted-existing'), p('u-self'), 'TRUSTED')
      await insertEnvelope(p('d-trusted-existing'), p('u-self'))
      await insertDevice(p('d-self'), p('u-self'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-self')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-self')}`,
            'X-Device-ID': p('d-self'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Only trusted devices can store envelopes')
    })

    it('allows self-recovery: pending device stores own envelope when canary matches stored metadata', async () => {
      await createUserAndSession(p('u-recov'), p('tok-recov'))
      // Existing trusted device with envelope (simulates pre-recovery state)
      await insertDevice(p('d-recov-old'), p('u-recov'), 'TRUSTED')
      await insertEnvelope(p('d-recov-old'), p('u-recov'))
      await insertCanary(p('u-recov'), 'recovery-iv', 'recovery-ctext')
      // New device registered during recovery flow
      await insertDevice(p('d-recov-new'), p('u-recov'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-recov-new')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-recov')}`,
            'X-Device-ID': p('d-recov-new'),
          },
          body: JSON.stringify({
            wrappedCK: 'recovered-wck',
            canaryIv: 'recovery-iv',
            canaryCtext: 'recovery-ctext',
          }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-recov-new')))
      expect(device.status).toBe('TRUSTED')
    })

    it('rejects self-recovery when canary does not match stored metadata', async () => {
      await createUserAndSession(p('u-badrecov'), p('tok-badrecov'))
      await insertDevice(p('d-badrecov-old'), p('u-badrecov'), 'TRUSTED')
      await insertEnvelope(p('d-badrecov-old'), p('u-badrecov'))
      await insertCanary(p('u-badrecov'), 'real-iv', 'real-ctext')
      await insertDevice(p('d-badrecov-new'), p('u-badrecov'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-badrecov-new')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-badrecov')}`,
            'X-Device-ID': p('d-badrecov-new'),
          },
          body: JSON.stringify({
            wrappedCK: 'wck',
            canaryIv: 'wrong-iv',
            canaryCtext: 'wrong-ctext',
          }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Only trusted devices can store envelopes')
    })

    it('rejects pending device from approving another pending device', async () => {
      await createUserAndSession(p('u-pp'), p('tok-pp'))
      // Need envelopes to exist so it's not first-device bootstrap
      await insertDevice(p('d-pp-trusted'), p('u-pp'), 'TRUSTED')
      await insertEnvelope(p('d-pp-trusted'), p('u-pp'))
      await insertDevice(p('d-pp-caller'), p('u-pp'), 'APPROVAL_PENDING')
      await insertDevice(p('d-pp-target'), p('u-pp'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-pp-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-pp')}`,
            'X-Device-ID': p('d-pp-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Only trusted devices can store envelopes')
    })

    it('returns 404 when target device belongs to different user', async () => {
      await createUserAndSession(p('u-diff1'), p('tok-diff1'), `${p('diff1')}@test.com`)
      await createUserAndSession(p('u-diff2'), p('tok-diff2'), `${p('diff2')}@test.com`)
      await insertDevice(p('d-diff-caller'), p('u-diff1'), 'TRUSTED')
      await insertEnvelope(p('d-diff-caller'), p('u-diff1'))
      await insertDevice(p('d-diff-target'), p('u-diff2'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-diff-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-diff1')}`,
            'X-Device-ID': p('d-diff-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Device not found')
    })

    it('returns 403 when caller device belongs to different user', async () => {
      await createUserAndSession(p('u-cdiff1'), p('tok-cdiff1'), `${p('cdiff1')}@test.com`)
      await createUserAndSession(p('u-cdiff2'), p('tok-cdiff2'), `${p('cdiff2')}@test.com`)
      await insertDevice(p('d-cdiff-target'), p('u-cdiff1'), 'APPROVAL_PENDING')
      await insertDevice(p('d-cdiff-caller'), p('u-cdiff2'), 'TRUSTED')
      await insertEnvelope(p('d-cdiff-caller'), p('u-cdiff2'))
      // Need envelopes for u-cdiff1 to avoid first-device bootstrap
      await insertDevice(p('d-cdiff-existing'), p('u-cdiff1'), 'TRUSTED')
      await insertEnvelope(p('d-cdiff-existing'), p('u-cdiff1'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-cdiff-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-cdiff1')}`,
            'X-Device-ID': p('d-cdiff-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Caller device not found')
    })

    it('returns 403 when target device is revoked', async () => {
      await createUserAndSession(p('u-trev'), p('tok-trev'))
      await insertDevice(p('d-trev-caller'), p('u-trev'), 'TRUSTED')
      await insertEnvelope(p('d-trev-caller'), p('u-trev'))
      await insertDevice(p('d-trev-target'), p('u-trev'), 'REVOKED')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-trev-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-trev')}`,
            'X-Device-ID': p('d-trev-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Device has been revoked')
    })

    it('returns 403 when caller device is revoked', async () => {
      await createUserAndSession(p('u-crev'), p('tok-crev'))
      await insertDevice(p('d-crev-caller'), p('u-crev'), 'REVOKED')
      await insertDevice(p('d-crev-target'), p('u-crev'), 'APPROVAL_PENDING')
      // Need envelopes so it's not bootstrap
      await insertDevice(p('d-crev-existing'), p('u-crev'), 'TRUSTED')
      await insertEnvelope(p('d-crev-existing'), p('u-crev'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-crev-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-crev')}`,
            'X-Device-ID': p('d-crev-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Only trusted devices can store envelopes')
    })

    it('returns 409 when overwriting trusted device envelope from another device', async () => {
      await createUserAndSession(p('u-ow'), p('tok-ow'))
      await insertDevice(p('d-ow-caller'), p('u-ow'), 'TRUSTED')
      await insertEnvelope(p('d-ow-caller'), p('u-ow'))
      await insertDevice(p('d-ow-target'), p('u-ow'), 'TRUSTED')
      await insertEnvelope(p('d-ow-target'), p('u-ow'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-ow-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-ow')}`,
            'X-Device-ID': p('d-ow-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'new-wck' }),
        }),
      )

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('Cannot overwrite envelope of an already-trusted device')
    })

    it('allows trusted device to re-key its own envelope', async () => {
      await createUserAndSession(p('u-rekey'), p('tok-rekey'))
      await insertDevice(p('d-rekey'), p('u-rekey'), 'TRUSTED')
      await insertEnvelope(p('d-rekey'), p('u-rekey'), 'old-wck')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-rekey')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-rekey')}`,
            'X-Device-ID': p('d-rekey'),
          },
          body: JSON.stringify({ wrappedCK: 'new-wck' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')

      const [envelope] = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.deviceId, p('d-rekey')))
      expect(envelope.wrappedCk).toBe('new-wck')
    })

    it('returns 404 when target deviceId does not exist', async () => {
      await createUserAndSession(p('u-nodev'), p('tok-nodev'))
      await insertDevice(p('d-nodev-caller'), p('u-nodev'), 'TRUSTED')
      await insertEnvelope(p('d-nodev-caller'), p('u-nodev'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-nonexistent')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-nodev')}`,
            'X-Device-ID': p('d-nodev-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Device not found')
    })

    it('returns 403 when caller deviceId does not exist (non-first-device scenario)', async () => {
      await createUserAndSession(p('u-nocaller'), p('tok-nocaller'))
      await insertDevice(p('d-nocaller-target'), p('u-nocaller'), 'APPROVAL_PENDING')
      // Need envelopes to exist
      await insertDevice(p('d-nocaller-existing'), p('u-nocaller'), 'TRUSTED')
      await insertEnvelope(p('d-nocaller-existing'), p('u-nocaller'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-nocaller-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-nocaller')}`,
            'X-Device-ID': p('d-ghost'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Caller device not found')
    })

    it('allows trusted device to approve a pending device', async () => {
      await createUserAndSession(p('u-approve'), p('tok-approve'))
      await insertDevice(p('d-approve-caller'), p('u-approve'), 'TRUSTED')
      await insertEnvelope(p('d-approve-caller'), p('u-approve'))
      await insertDevice(p('d-approve-target'), p('u-approve'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-approve-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-approve')}`,
            'X-Device-ID': p('d-approve-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'target-wck' }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-approve-target')))
      expect(device.status).toBe('TRUSTED')

      const [envelope] = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.deviceId, p('d-approve-target')))
      expect(envelope.wrappedCk).toBe('target-wck')
    })

    it('stores canary on first-device bootstrap', async () => {
      await createUserAndSession(p('u-canary'), p('tok-canary'))
      await insertDevice(p('d-canary'), p('u-canary'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-canary')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-canary')}`,
            'X-Device-ID': p('d-canary'),
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
        .where(eq(encryptionMetadataTable.userId, p('u-canary')))
      expect(metadata).toBeDefined()
      expect(metadata.canaryIv).toBe('my-iv')
      expect(metadata.canaryCtext).toBe('my-ctext')
    })

    it('does not overwrite existing canary on subsequent envelope submissions', async () => {
      await createUserAndSession(p('u-noow'), p('tok-noow'))
      await insertDevice(p('d-noow-caller'), p('u-noow'), 'TRUSTED')
      await insertEnvelope(p('d-noow-caller'), p('u-noow'))
      await insertCanary(p('u-noow'), 'original-iv', 'original-ctext')
      await insertDevice(p('d-noow-target'), p('u-noow'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-noow-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p('tok-noow')}`,
            'X-Device-ID': p('d-noow-caller'),
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
        .where(eq(encryptionMetadataTable.userId, p('u-noow')))
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
      await createUserAndSession(p('u-me1'), p('tok-me1'))

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: { Authorization: `Bearer ${p('tok-me1')}` },
        }),
      )

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('X-Device-ID header is required')
    })

    it('returns envelope for trusted device', async () => {
      await createUserAndSession(p('u-me2'), p('tok-me2'))
      await insertDevice(p('d-me2'), p('u-me2'), 'TRUSTED')
      await insertEnvelope(p('d-me2'), p('u-me2'), 'my-wrapped-ck')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${p('tok-me2')}`,
            'X-Device-ID': p('d-me2'),
          },
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('TRUSTED')
      expect(body.wrappedCK).toBe('my-wrapped-ck')
    })

    it('returns 404 when device belongs to different user', async () => {
      await createUserAndSession(p('u-me3a'), p('tok-me3a'), `${p('me3a')}@test.com`)
      await createUserAndSession(p('u-me3b'), p('tok-me3b'), `${p('me3b')}@test.com`)
      await insertDevice(p('d-me3'), p('u-me3b'), 'TRUSTED')
      await insertEnvelope(p('d-me3'), p('u-me3b'))

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${p('tok-me3a')}`,
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
      await insertDevice(p('d-me4'), p('u-me4'), 'REVOKED')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${p('tok-me4')}`,
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
      await insertDevice(p('d-me5'), p('u-me5'), 'APPROVAL_PENDING')

      const response = await app.handle(
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${p('tok-me5')}`,
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
        new Request(`${BASE}/devices/me/envelope`, {
          headers: {
            Authorization: `Bearer ${p('tok-me6')}`,
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
      const response = await app.handle(new Request(`${BASE}/encryption/canary`))
      expect(response.status).toBe(401)
    })

    it('returns canary when set up', async () => {
      await createUserAndSession(p('u-can1'), p('tok-can1'))
      await insertCanary(p('u-can1'), 'stored-iv', 'stored-ctext')

      const response = await app.handle(
        new Request(`${BASE}/encryption/canary`, {
          headers: { Authorization: `Bearer ${p('tok-can1')}` },
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.canaryIv).toBe('stored-iv')
      expect(body.canaryCtext).toBe('stored-ctext')
    })

    it('returns 404 when encryption not set up', async () => {
      await createUserAndSession(p('u-can2'), p('tok-can2'))

      const response = await app.handle(
        new Request(`${BASE}/encryption/canary`, {
          headers: { Authorization: `Bearer ${p('tok-can2')}` },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Encryption not set up')
    })
  })
})
