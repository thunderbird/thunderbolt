import { createAuth } from '@/auth/auth'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { encryptionMetadataTable, envelopesTable } from '@/db/encryption-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { createHmac } from 'crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createEncryptionRoutes } from './encryption'

const BASE = 'http://localhost'

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
      approvalPending = true,
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

  /** SHA-256 hash helper matching the backend's hashCanarySecret. */
  const hashSecret = async (secret: string): Promise<string> => {
    const encoded = new TextEncoder().encode(secret)
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
    return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** Known canary secret for tests that require proof-of-CK-possession. */
  const testCanarySecret = 'test-canary-secret-for-proof'

  const insertCanary = async (
    userId: string,
    canaryIv = 'iv-test',
    canaryCtext = 'ctext-test',
    canarySecretHash?: string,
  ) => {
    await db.insert(encryptionMetadataTable).values({
      userId,
      canaryIv,
      canaryCtext,
      canarySecretHash: canarySecretHash ?? null,
      createdAt: now,
    })
  }

  /** Insert canary with a known secret hash for proof-of-CK-possession tests. */
  const insertCanaryWithSecret = async (userId: string) => {
    const hash = await hashSecret(testCanarySecret)
    await insertCanary(userId, 'iv-test', 'ctext-test', hash)
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
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk', mlkemPublicKey: 'mlkem-pk' }),
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
          body: JSON.stringify({ deviceId: p('d1'), publicKey: 'pk', mlkemPublicKey: 'mlkem-pk' }),
        }),
      )
      expect(response.status).toBe(401)
    })

    it('registers new device as untrusted', async () => {
      await createUserAndSession(p('u1'), p('tok-u1'))

      const response = await app.handle(
        new Request(`${BASE}/devices`, {
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
        new Request(`${BASE}/devices`, {
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
        new Request(`${BASE}/devices`, {
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
        new Request(`${BASE}/devices`, {
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
        new Request(`${BASE}/devices`, {
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
        new Request(`${BASE}/devices`, {
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
        new Request(`${BASE}/devices`, {
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
        new Request(`${BASE}/devices`, {
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
            Authorization: `Bearer ${signToken(p('tok-env1'))}`,
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
      await insertDevice(p('d-boot'), p('u-boot'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-boot')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-boot'))}`,
            'X-Device-ID': p('d-boot'),
          },
          body: JSON.stringify({
            wrappedCK: 'wrapped-ck-boot',
            canaryIv: 'test-canary-iv',
            canaryCtext: 'test-canary-ctext',
            canarySecret: 'test-canary-secret',
          }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(true)

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-boot')))
      expect(device.trusted).toBe(true)

      const [envelope] = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.deviceId, p('d-boot')))
      expect(envelope.wrappedCk).toBe('wrapped-ck-boot')
    })

    it('rejects pending device from approving itself when envelopes already exist (no canary proof)', async () => {
      await createUserAndSession(p('u-self'), p('tok-self'))
      await insertDevice(p('d-trusted-existing'), p('u-self'), { trusted: true })
      await insertEnvelope(p('d-trusted-existing'), p('u-self'))
      await insertDevice(p('d-self'), p('u-self'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-self')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-self'))}`,
            'X-Device-ID': p('d-self'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('allows self-recovery: pending device stores own envelope when canarySecret proves CK possession', async () => {
      const secret = 'my-recovery-secret'
      const secretHash = await hashSecret(secret)
      await createUserAndSession(p('u-recov'), p('tok-recov'))
      // Existing trusted device with envelope (simulates pre-recovery state)
      await insertDevice(p('d-recov-old'), p('u-recov'), { trusted: true })
      await insertEnvelope(p('d-recov-old'), p('u-recov'))
      await insertCanary(p('u-recov'), 'recovery-iv', 'recovery-ctext', secretHash)
      // New device registered during recovery flow
      await insertDevice(p('d-recov-new'), p('u-recov'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-recov-new')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-recov'))}`,
            'X-Device-ID': p('d-recov-new'),
          },
          body: JSON.stringify({
            wrappedCK: 'recovered-wck',
            canarySecret: secret,
          }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(true)

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-recov-new')))
      expect(device.trusted).toBe(true)
    })

    it('rejects self-recovery when canarySecret does not match stored hash', async () => {
      const secretHash = await hashSecret('real-secret')
      await createUserAndSession(p('u-badrecov'), p('tok-badrecov'))
      await insertDevice(p('d-badrecov-old'), p('u-badrecov'), { trusted: true })
      await insertEnvelope(p('d-badrecov-old'), p('u-badrecov'))
      await insertCanary(p('u-badrecov'), 'real-iv', 'real-ctext', secretHash)
      await insertDevice(p('d-badrecov-new'), p('u-badrecov'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-badrecov-new')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-badrecov'))}`,
            'X-Device-ID': p('d-badrecov-new'),
          },
          body: JSON.stringify({
            wrappedCK: 'wck',
            canarySecret: 'wrong-secret',
          }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Invalid canary secret')
    })

    it('rejects self-recovery when replaying canaryIv/canaryCtext without secret (old replay attack)', async () => {
      await createUserAndSession(p('u-replay'), p('tok-replay'))
      await insertDevice(p('d-replay-old'), p('u-replay'), { trusted: true })
      await insertEnvelope(p('d-replay-old'), p('u-replay'))
      await insertCanary(p('u-replay'), 'the-iv', 'the-ctext', await hashSecret('the-secret'))
      await insertDevice(p('d-replay-new'), p('u-replay'))

      // Attacker replays canaryIv/canaryCtext from GET /encryption/canary without the secret
      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-replay-new')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-replay'))}`,
            'X-Device-ID': p('d-replay-new'),
          },
          body: JSON.stringify({
            wrappedCK: 'attacker-wck',
            canaryIv: 'the-iv',
            canaryCtext: 'the-ctext',
          }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('rejects pending device from approving another pending device', async () => {
      await createUserAndSession(p('u-pp'), p('tok-pp'))
      // Need envelopes to exist so it's not first-device bootstrap
      await insertDevice(p('d-pp-trusted'), p('u-pp'), { trusted: true })
      await insertEnvelope(p('d-pp-trusted'), p('u-pp'))
      await insertDevice(p('d-pp-caller'), p('u-pp'))
      await insertDevice(p('d-pp-target'), p('u-pp'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-pp-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-pp'))}`,
            'X-Device-ID': p('d-pp-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('returns 404 when target device belongs to different user', async () => {
      await createUserAndSession(p('u-diff1'), p('tok-diff1'), `${p('diff1')}@test.com`)
      await createUserAndSession(p('u-diff2'), p('tok-diff2'), `${p('diff2')}@test.com`)
      await insertDevice(p('d-diff-caller'), p('u-diff1'), { trusted: true })
      await insertEnvelope(p('d-diff-caller'), p('u-diff1'))
      await insertDevice(p('d-diff-target'), p('u-diff2'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-diff-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-diff1'))}`,
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
      await insertDevice(p('d-cdiff-target'), p('u-cdiff1'))
      await insertDevice(p('d-cdiff-caller'), p('u-cdiff2'), { trusted: true })
      await insertEnvelope(p('d-cdiff-caller'), p('u-cdiff2'))
      // Need envelopes for u-cdiff1 to avoid first-device bootstrap
      await insertDevice(p('d-cdiff-existing'), p('u-cdiff1'), { trusted: true })
      await insertEnvelope(p('d-cdiff-existing'), p('u-cdiff1'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-cdiff-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-cdiff1'))}`,
            'X-Device-ID': p('d-cdiff-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('returns 403 when target device is revoked', async () => {
      await createUserAndSession(p('u-trev'), p('tok-trev'))
      await insertDevice(p('d-trev-caller'), p('u-trev'), { trusted: true })
      await insertEnvelope(p('d-trev-caller'), p('u-trev'))
      await insertDevice(p('d-trev-target'), p('u-trev'), { revokedAt: now })

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-trev-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-trev'))}`,
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
      await insertDevice(p('d-crev-caller'), p('u-crev'), { revokedAt: now })
      await insertDevice(p('d-crev-target'), p('u-crev'))
      // Need envelopes so it's not bootstrap
      await insertDevice(p('d-crev-existing'), p('u-crev'), { trusted: true })
      await insertEnvelope(p('d-crev-existing'), p('u-crev'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-crev-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-crev'))}`,
            'X-Device-ID': p('d-crev-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('returns 409 when overwriting trusted device envelope from another device', async () => {
      await createUserAndSession(p('u-ow'), p('tok-ow'))
      await insertDevice(p('d-ow-caller'), p('u-ow'), { trusted: true })
      await insertEnvelope(p('d-ow-caller'), p('u-ow'))
      await insertDevice(p('d-ow-target'), p('u-ow'), { trusted: true })
      await insertEnvelope(p('d-ow-target'), p('u-ow'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-ow-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-ow'))}`,
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
      await insertDevice(p('d-rekey'), p('u-rekey'), { trusted: true })
      await insertEnvelope(p('d-rekey'), p('u-rekey'), 'old-wck')
      await insertCanaryWithSecret(p('u-rekey'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-rekey')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-rekey'))}`,
            'X-Device-ID': p('d-rekey'),
          },
          body: JSON.stringify({ wrappedCK: 'new-wck', canarySecret: testCanarySecret }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(true)

      const [envelope] = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.deviceId, p('d-rekey')))
      expect(envelope.wrappedCk).toBe('new-wck')
    })

    it('returns 404 when target deviceId does not exist', async () => {
      await createUserAndSession(p('u-nodev'), p('tok-nodev'))
      await insertDevice(p('d-nodev-caller'), p('u-nodev'), { trusted: true })
      await insertEnvelope(p('d-nodev-caller'), p('u-nodev'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-nonexistent')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-nodev'))}`,
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
      await insertDevice(p('d-nocaller-target'), p('u-nocaller'))
      // Need envelopes to exist
      await insertDevice(p('d-nocaller-existing'), p('u-nocaller'), { trusted: true })
      await insertEnvelope(p('d-nocaller-existing'), p('u-nocaller'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-nocaller-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-nocaller'))}`,
            'X-Device-ID': p('d-ghost'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('allows trusted device to approve a pending device', async () => {
      await createUserAndSession(p('u-approve'), p('tok-approve'))
      await insertDevice(p('d-approve-caller'), p('u-approve'), { trusted: true })
      await insertEnvelope(p('d-approve-caller'), p('u-approve'))
      await insertDevice(p('d-approve-target'), p('u-approve'))
      await insertCanaryWithSecret(p('u-approve'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-approve-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-approve'))}`,
            'X-Device-ID': p('d-approve-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'target-wck', canarySecret: testCanarySecret }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(true)

      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-approve-target')))
      expect(device.trusted).toBe(true)

      const [envelope] = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.deviceId, p('d-approve-target')))
      expect(envelope.wrappedCk).toBe('target-wck')
    })

    it('rejects approval without canarySecret', async () => {
      await createUserAndSession(p('u-noproof'), p('tok-noproof'))
      await insertDevice(p('d-noproof-caller'), p('u-noproof'), { trusted: true })
      await insertEnvelope(p('d-noproof-caller'), p('u-noproof'))
      await insertDevice(p('d-noproof-target'), p('u-noproof'))
      await insertCanaryWithSecret(p('u-noproof'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-noproof-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-noproof'))}`,
            'X-Device-ID': p('d-noproof-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('rejects approval with wrong canarySecret', async () => {
      await createUserAndSession(p('u-badproof'), p('tok-badproof'))
      await insertDevice(p('d-badproof-caller'), p('u-badproof'), { trusted: true })
      await insertEnvelope(p('d-badproof-caller'), p('u-badproof'))
      await insertDevice(p('d-badproof-target'), p('u-badproof'))
      await insertCanaryWithSecret(p('u-badproof'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-badproof-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-badproof'))}`,
            'X-Device-ID': p('d-badproof-caller'),
          },
          body: JSON.stringify({ wrappedCK: 'wck', canarySecret: 'wrong-secret' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Invalid canary secret')
    })

    it('rejects spoofed X-Device-ID even with untrusted caller claiming to be trusted', async () => {
      await createUserAndSession(p('u-spoof'), p('tok-spoof'))
      await insertDevice(p('d-spoof-trusted'), p('u-spoof'), { trusted: true })
      await insertEnvelope(p('d-spoof-trusted'), p('u-spoof'))
      await insertDevice(p('d-spoof-pending'), p('u-spoof'))
      await insertCanaryWithSecret(p('u-spoof'))

      // Pending device spoofs X-Device-ID to trusted device — but cannot provide canary secret
      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-spoof-pending')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-spoof'))}`,
            'X-Device-ID': p('d-spoof-trusted'),
          },
          body: JSON.stringify({ wrappedCK: 'attacker-wck' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Canary secret required for device approval')
    })

    it('stores canary with secret hash on first-device bootstrap', async () => {
      await createUserAndSession(p('u-canary'), p('tok-canary'))
      await insertDevice(p('d-canary'), p('u-canary'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-canary')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-canary'))}`,
            'X-Device-ID': p('d-canary'),
          },
          body: JSON.stringify({
            wrappedCK: 'wck',
            canaryIv: 'my-iv',
            canaryCtext: 'my-ctext',
            canarySecret: 'my-secret',
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
      expect(metadata.canarySecretHash).toBe(await hashSecret('my-secret'))
    })

    it('blocks re-bootstrap with wrong canary when encryption metadata already exists (defense-in-depth)', async () => {
      await createUserAndSession(p('u-reboot'), p('tok-reboot'))
      await insertDevice(p('d-reboot'), p('u-reboot'))
      // Simulate existing encryption metadata from a previous first-device setup
      await insertCanaryWithSecret(p('u-reboot'))
      // No envelopes exist — simulates state after all devices revoked/envelopes deleted

      // Attacker tries first-device bootstrap with a fake canary secret
      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-reboot')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-reboot'))}`,
            'X-Device-ID': p('d-reboot'),
          },
          body: JSON.stringify({
            wrappedCK: 'attacker-controlled-key',
            canaryIv: 'attacker-iv',
            canaryCtext: 'attacker-ctext',
            canarySecret: 'wrong-secret',
          }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toContain('Invalid canary secret')

      // No envelope should have been stored
      const envelopes = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.deviceId, p('d-reboot')))
      expect(envelopes).toHaveLength(0)
    })

    it('allows re-bootstrap with correct canary when encryption metadata already exists', async () => {
      await createUserAndSession(p('u-recover'), p('tok-recover'))
      await insertDevice(p('d-recover'), p('u-recover'))
      await insertCanaryWithSecret(p('u-recover'))
      // No envelopes — simulates recovery after all devices revoked

      // Legitimate user re-bootstraps with the correct canary secret (e.g. from recovery key)
      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-recover')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-recover'))}`,
            'X-Device-ID': p('d-recover'),
          },
          body: JSON.stringify({
            wrappedCK: 'recovered-wrapped-key',
            canaryIv: 'recover-iv',
            canaryCtext: 'recover-ctext',
            canarySecret: testCanarySecret,
          }),
        }),
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.trusted).toBe(true)

      // Device should be trusted
      const [device] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('d-recover')))
      expect(device.trusted).toBe(true)
    })

    it('does not overwrite existing canary on subsequent envelope submissions', async () => {
      await createUserAndSession(p('u-noow'), p('tok-noow'))
      await insertDevice(p('d-noow-caller'), p('u-noow'), { trusted: true })
      await insertEnvelope(p('d-noow-caller'), p('u-noow'))
      await insertCanary(p('u-noow'), 'original-iv', 'original-ctext', await hashSecret(testCanarySecret))
      await insertDevice(p('d-noow-target'), p('u-noow'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-noow-target')}/envelope`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-noow'))}`,
            'X-Device-ID': p('d-noow-caller'),
          },
          body: JSON.stringify({
            wrappedCK: 'wck',
            canaryIv: 'new-iv',
            canaryCtext: 'new-ctext',
            canarySecret: testCanarySecret,
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
        new Request(`${BASE}/devices/me/envelope`, {
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
        new Request(`${BASE}/devices/me/envelope`, {
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
        new Request(`${BASE}/devices/me/envelope`, {
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
        new Request(`${BASE}/devices/me/envelope`, {
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
        new Request(`${BASE}/devices/me/envelope`, {
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
      const response = await app.handle(new Request(`${BASE}/encryption/canary`))
      expect(response.status).toBe(401)
    })

    it('returns canary when set up', async () => {
      await createUserAndSession(p('u-can1'), p('tok-can1'))
      await insertCanary(p('u-can1'), 'stored-iv', 'stored-ctext')

      const response = await app.handle(
        new Request(`${BASE}/encryption/canary`, {
          headers: { Authorization: `Bearer ${signToken(p('tok-can1'))}` },
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
          headers: { Authorization: `Bearer ${signToken(p('tok-can2'))}` },
        }),
      )

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error).toBe('Encryption not set up')
    })
  })

  // ─── POST /devices/:deviceId/deny ───────────────────────────────────

  describe('POST /devices/:deviceId/deny', () => {
    it('rejects deny without canarySecret (body validation)', async () => {
      await createUserAndSession(p('u-deny-nobody'), p('tok-deny-nobody'))
      await insertDevice(p('d-deny-nobody-caller'), p('u-deny-nobody'), { trusted: true })
      await insertDevice(p('d-deny-nobody-target'), p('u-deny-nobody'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-deny-nobody-target')}/deny`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-deny-nobody'))}`,
            'X-Device-ID': p('d-deny-nobody-caller'),
          },
        }),
      )

      expect(response.status).toBe(422)
    })

    it('rejects deny with wrong canarySecret', async () => {
      await createUserAndSession(p('u-deny-bad'), p('tok-deny-bad'))
      await insertDevice(p('d-deny-bad-caller'), p('u-deny-bad'), { trusted: true })
      await insertDevice(p('d-deny-bad-target'), p('u-deny-bad'))
      await insertCanaryWithSecret(p('u-deny-bad'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-deny-bad-target')}/deny`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-deny-bad'))}`,
            'X-Device-ID': p('d-deny-bad-caller'),
          },
          body: JSON.stringify({ canarySecret: 'wrong-secret' }),
        }),
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('Invalid canary secret')
    })

    it('allows deny with valid canarySecret', async () => {
      await createUserAndSession(p('u-deny-ok'), p('tok-deny-ok'))
      await insertDevice(p('d-deny-ok-caller'), p('u-deny-ok'), { trusted: true })
      await insertDevice(p('d-deny-ok-target'), p('u-deny-ok'))
      await insertCanaryWithSecret(p('u-deny-ok'))

      const response = await app.handle(
        new Request(`${BASE}/devices/${p('d-deny-ok-target')}/deny`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signToken(p('tok-deny-ok'))}`,
            'X-Device-ID': p('d-deny-ok-caller'),
          },
          body: JSON.stringify({ canarySecret: testCanarySecret }),
        }),
      )

      expect(response.status).toBe(204)
    })
  })
})
