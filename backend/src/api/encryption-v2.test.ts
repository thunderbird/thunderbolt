/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { challengeNoncesTable, encryptionMetadataTable, envelopesTable, wrappedKeysTable } from '@/db/encryption-schema'
import { devicesTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { exportSigningPublicKey, generateSigningKeypair, signChallenge } from '@/test-utils/e2ee'
import { initialKeyId, legacyKeyId } from '@shared/e2ee-types'
import { createHmac } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createEncryptionRoutes } from './encryption'

const baseUrl = 'http://localhost'

const betterAuthSecret = 'better-auth-secret-12345678901234567890'
const signToken = (token: string): string =>
  `${token}.${createHmac('sha256', betterAuthSecret).update(token).digest('base64')}`

const counterKey = Symbol.for('encryption-v2-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

/** The recovery slot: the phrase-derived hybrid public keys plus the AK wrapped to them. */
const recoverySlot = {
  recoveryEcdhPublicKey: 'recovery-ecdh-pk',
  recoveryMlkemPublicKey: 'recovery-mlkem-pk',
  recoveryWrappedAK: 'recovery-wrapped-ak',
}

/** SHA-256 hex — matches the backend's hashCanarySecret (D1 possession anchor). */
const hashSecret = async (secret: string): Promise<string> => {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('Encryption API (v2)', () => {
  let app: ReturnType<typeof createEncryptionRoutes>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let p: (id: string) => string

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 3600 * 1000)

  const authHeaders = (token: string, deviceId?: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${signToken(token)}`,
    ...(deviceId ? { 'X-Device-ID': deviceId } : {}),
  })

  const createUserAndSession = async (userId: string, token: string) => {
    await db.insert(userTable).values({
      id: userId,
      name: 'Test User',
      email: `${userId}@test.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await db
      .insert(sessionTable)
      .values({ id: `session-${userId}`, expiresAt, token, createdAt: now, updatedAt: now, userId })
  }

  const insertDevice = async (
    id: string,
    userId: string,
    options: { trusted?: boolean; approvalPending?: boolean; revokedAt?: Date; keyless?: boolean } = {},
  ) => {
    const { trusted = false, approvalPending = !trusted, revokedAt, keyless = false } = options
    await db.insert(devicesTable).values({
      id,
      userId,
      name: 'Test Device',
      trusted,
      approvalPending,
      // `keyless` mirrors a bridge (`registerBridgeDevice`) or a v1 device that
      // never published v2 keys: trusted, but no envelope can be built for it.
      publicKey: keyless ? null : 'pk-test',
      mlkemPublicKey: keyless ? null : 'mlkem-pk-test',
      lastSeen: now,
      createdAt: now,
      ...(revokedAt ? { revokedAt } : {}),
    })
  }

  const insertEnvelope = async (deviceId: string, userId: string, wrappedCk = 'wrapped-ak') => {
    await db.insert(envelopesTable).values({ deviceId, userId, wrappedCk, createdAt: now, updatedAt: now })
  }

  const insertWrappedKeyRow = async (userId: string, keyId: string, wrappedKey = `wrapped-${keyId}`) => {
    await db.insert(wrappedKeysTable).values({ userId, keyId, wrappedKey, createdAt: now, updatedAt: now })
  }

  /**
   * Insert a fully set-up v2 encryption_metadata row (scheme 2, with a signing
   * key and a recovery slot). `signingKeyNull` models a pre-flip v1 account,
   * which has neither a signing key nor a recovery slot.
   */
  const insertV2Metadata = async (
    userId: string,
    signingPublicKey: string,
    options: { schemeVersion?: 1 | 2; canarySecretHash?: string; signingKeyNull?: boolean } = {},
  ) => {
    const { schemeVersion = 2, canarySecretHash, signingKeyNull = false } = options
    await db.insert(encryptionMetadataTable).values({
      userId,
      canaryIv: 'iv-test',
      canaryCtext: 'ctext-test',
      canarySecretHash: canarySecretHash ?? null,
      signingPublicKey: signingKeyNull ? null : signingPublicKey,
      kdfSalt: 'salt-test',
      recoveryEcdhPublicKey: signingKeyNull ? null : recoverySlot.recoveryEcdhPublicKey,
      recoveryMlkemPublicKey: signingKeyNull ? null : recoverySlot.recoveryMlkemPublicKey,
      recoveryWrappedAk: signingKeyNull ? null : recoverySlot.recoveryWrappedAK,
      keyVersion: 1,
      primaryKeyId: initialKeyId,
      schemeVersion,
      createdAt: now,
    })
  }

  /** Issue a challenge nonce through the real endpoint, then sign it with the given keypair. */
  const proofFor = async (
    token: string,
    callerDeviceId: string,
    operation: 'approve' | 'deny' | 'rotate',
    keypair: CryptoKeyPair,
  ) => {
    const res = await app.handle(
      new Request(`${baseUrl}/encryption/challenge?operation=${operation}`, {
        headers: authHeaders(token, callerDeviceId),
      }),
    )
    expect(res.status).toBe(200)
    const { nonce } = await res.json()
    const signature = await signChallenge(keypair.privateKey, nonce, operation, callerDeviceId)
    return { signature, nonce, operation, deviceId: callerDeviceId }
  }

  const issueNonce = async (token: string, callerDeviceId: string, operation: string): Promise<string> => {
    const res = await app.handle(
      new Request(`${baseUrl}/encryption/challenge?operation=${operation}`, {
        headers: authHeaders(token, callerDeviceId),
      }),
    )
    expect(res.status).toBe(200)
    return (await res.json()).nonce
  }

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `v2-${rid}-${id}`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const auth = createAuth(db)
    app = new Elysia().use(createEncryptionRoutes(auth, db)) as unknown as ReturnType<typeof createEncryptionRoutes>
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  // ─── First-device bootstrap ─────────────────────────────────────────

  describe('POST /devices/:deviceId/envelope — first-device bootstrap', () => {
    it('sets up a v2 account atomically (metadata scheme 2 + wrapped key "0")', async () => {
      const keypair = await generateSigningKeypair()
      const signingPublicKey = await exportSigningPublicKey(keypair)
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/${p('d')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('d')),
          body: JSON.stringify({
            wrappedCK: 'wrapped-ak-boot',
            canaryIv: 'boot-iv',
            canaryCtext: 'boot-ctext',
            signingPublicKey,
            kdfSalt: 'boot-salt',
            wrappedKeys: [{ keyId: initialKeyId, wrappedKey: 'wrapped-dek-0' }],
            ...recoverySlot,
          }),
        }),
      )

      expect(response.status).toBe(200)
      expect((await response.json()).trusted).toBe(true)

      const [metadata] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, p('u')))
      expect(metadata.schemeVersion).toBe(2)
      expect(metadata.signingPublicKey).toBe(signingPublicKey)
      expect(metadata.kdfSalt).toBe('boot-salt')
      expect(metadata.recoveryEcdhPublicKey).toBe(recoverySlot.recoveryEcdhPublicKey)
      expect(metadata.recoveryMlkemPublicKey).toBe(recoverySlot.recoveryMlkemPublicKey)
      expect(metadata.recoveryWrappedAk).toBe(recoverySlot.recoveryWrappedAK)
      const [key] = await db
        .select()
        .from(wrappedKeysTable)
        .where(eq(wrappedKeysTable.userId, p('u')))
      expect(key.keyId).toBe(initialKeyId)
    })

    it('rejects bootstrap without a wrapped key for the primary key_id "0"', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/${p('d')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('d')),
          body: JSON.stringify({
            wrappedCK: 'wrapped-ak',
            canaryIv: 'iv',
            canaryCtext: 'ctext',
            signingPublicKey: await exportSigningPublicKey(keypair),
            kdfSalt: 'salt',
            wrappedKeys: [{ keyId: 'ws1', wrappedKey: 'wrapped-ws' }],
            ...recoverySlot,
          }),
        }),
      )

      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain(initialKeyId)
    })

    it.each([
      ['the whole recovery triple', {}],
      ['recoveryEcdhPublicKey', { recoveryMlkemPublicKey: 'm', recoveryWrappedAK: 'w' }],
      ['recoveryMlkemPublicKey', { recoveryEcdhPublicKey: 'e', recoveryWrappedAK: 'w' }],
      ['recoveryWrappedAK', { recoveryEcdhPublicKey: 'e', recoveryMlkemPublicKey: 'm' }],
    ])('rejects bootstrap missing %s — no account may exist without a usable recovery slot', async (_label, slot) => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/${p('d')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('d')),
          body: JSON.stringify({
            wrappedCK: 'wrapped-ak',
            canaryIv: 'iv',
            canaryCtext: 'ctext',
            signingPublicKey: await exportSigningPublicKey(keypair),
            kdfSalt: 'salt',
            wrappedKeys: [{ keyId: initialKeyId, wrappedKey: 'wrapped-dek-0' }],
            ...slot,
          }),
        }),
      )

      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('recoveryEcdhPublicKey')

      // Nothing half-configured was written.
      const rows = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, p('u')))
      expect(rows).toHaveLength(0)
    })

    it('rejects bootstrap when metadata already exists without a proof', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('d'), p('u'))

      const response = await app.handle(
        new Request(`${baseUrl}/devices/${p('d')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('d')),
          body: JSON.stringify({ wrappedCK: 'wrapped-ak' }),
        }),
      )

      expect(response.status).toBe(403)
      expect((await response.json()).error).toBe('Challenge proof required for device approval')
    })
  })

  // ─── Approve via challenge signature ────────────────────────────────

  describe('POST /devices/:deviceId/envelope — approval (challenge proof)', () => {
    it('approves a pending device with a valid rotate/approve signature', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertEnvelope(p('caller'), p('u'))
      await insertDevice(p('target'), p('u'))

      const proof = await proofFor(p('tok'), p('caller'), 'approve', keypair)
      const response = await app.handle(
        new Request(`${baseUrl}/devices/${p('target')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ wrappedCK: 'target-ak', proof }),
        }),
      )

      expect(response.status).toBe(200)
      const [target] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('target')))
      expect(target.trusted).toBe(true)
    })

    it('rejects approval when the signature is forged (wrong keypair)', async () => {
      const realKeypair = await generateSigningKeypair()
      const attackerKeypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(realKeypair))
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertEnvelope(p('caller'), p('u'))
      await insertDevice(p('target'), p('u'))

      // Signed with the attacker's key, not the account signing key.
      const proof = await proofFor(p('tok'), p('caller'), 'approve', attackerKeypair)
      const response = await app.handle(
        new Request(`${baseUrl}/devices/${p('target')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ wrappedCK: 'target-ak', proof }),
        }),
      )

      expect(response.status).toBe(403)
      expect((await response.json()).error).toBe('Invalid challenge proof')
    })

    it('rejects a pre-flip v1 account (null signing key) fail-closed', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair), { schemeVersion: 1, signingKeyNull: true })
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertEnvelope(p('caller'), p('u'))
      await insertDevice(p('target'), p('u'))

      const proof = await proofFor(p('tok'), p('caller'), 'approve', keypair)
      const response = await app.handle(
        new Request(`${baseUrl}/devices/${p('target')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ wrappedCK: 'target-ak', proof }),
        }),
      )

      expect(response.status).toBe(403)
    })
  })

  // ─── GET /encryption/challenge ──────────────────────────────────────

  describe('GET /encryption/challenge', () => {
    it('issues a single-use nonce bound to (user, operation, device)', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'), { trusted: true })

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/challenge?operation=approve`, { headers: authHeaders(p('tok'), p('d')) }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(typeof body.nonce).toBe('string')
      expect(typeof body.expires_at).toBe('string')

      const [row] = await db.select().from(challengeNoncesTable).where(eq(challengeNoncesTable.nonce, body.nonce))
      expect(row.operation).toBe('approve')
      expect(row.deviceId).toBe(p('d'))
      expect(row.consumed).toBe(false)
    })

    it('rejects an unknown operation', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'), { trusted: true })
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/challenge?operation=bogus`, { headers: authHeaders(p('tok'), p('d')) }),
      )
      expect(res.status).toBe(400)
    })

    it('rejects a missing X-Device-ID header', async () => {
      await createUserAndSession(p('u'), p('tok'))
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/challenge?operation=approve`, { headers: authHeaders(p('tok')) }),
      )
      expect(res.status).toBe(400)
    })

    it('nonce consumes exactly once (replay is rejected)', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertEnvelope(p('caller'), p('u'))
      await insertDevice(p('t1'), p('u'))
      await insertDevice(p('t2'), p('u'))

      const proof = await proofFor(p('tok'), p('caller'), 'approve', keypair)
      const first = await app.handle(
        new Request(`${baseUrl}/devices/${p('t1')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ wrappedCK: 'ak1', proof }),
        }),
      )
      expect(first.status).toBe(200)

      // Reuse the same proof/nonce on another device — must fail (nonce already consumed).
      const replay = await app.handle(
        new Request(`${baseUrl}/devices/${p('t2')}/envelope`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ wrappedCK: 'ak2', proof }),
        }),
      )
      expect(replay.status).toBe(403)
    })
  })

  // ─── Wrapped-DEK keyring ────────────────────────────────────────────

  describe('GET/POST /encryption/keys', () => {
    it('returns the full keyring for a non-revoked device', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'), { trusted: true })
      await insertWrappedKeyRow(p('u'), initialKeyId)
      await insertWrappedKeyRow(p('u'), legacyKeyId)

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/keys`, { headers: authHeaders(p('tok'), p('d')) }),
      )
      expect(res.status).toBe(200)
      const keys = (await res.json()).keys as Array<{ key_id: string }>
      expect(keys.map((k) => k.key_id).sort()).toEqual([initialKeyId, legacyKeyId].sort())
    })

    it('rejects a revoked device (403)', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'), { trusted: true, revokedAt: now })
      await insertWrappedKeyRow(p('u'), initialKeyId)

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/keys`, { headers: authHeaders(p('tok'), p('d')) }),
      )
      expect(res.status).toBe(403)
    })

    it('returns one wrapped key and 404 for an unknown key_id', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'), { trusted: true })
      await insertWrappedKeyRow(p('u'), initialKeyId, 'the-wrapped-dek')

      const ok = await app.handle(
        new Request(`${baseUrl}/encryption/keys/${initialKeyId}`, { headers: authHeaders(p('tok'), p('d')) }),
      )
      expect(ok.status).toBe(200)
      expect((await ok.json()).wrapped_key).toBe('the-wrapped-dek')

      const missing = await app.handle(
        new Request(`${baseUrl}/encryption/keys/does-not-exist`, { headers: authHeaders(p('tok'), p('d')) }),
      )
      expect(missing.status).toBe(404)
    })

    it('POST mints a new key_id idempotently (ON CONFLICT DO NOTHING)', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('d'), p('u'), { trusted: true })

      // A fresh 'rotate' proof per POST (nonces are single-use).
      const post = async (wrappedKey: string) =>
        app.handle(
          new Request(`${baseUrl}/encryption/keys`, {
            method: 'POST',
            headers: authHeaders(p('tok'), p('d')),
            body: JSON.stringify({
              keyId: '1',
              wrappedKey,
              setPrimary: true,
              proof: await proofFor(p('tok'), p('d'), 'rotate', keypair),
            }),
          }),
        )

      expect((await post('first')).status).toBe(200)
      expect((await post('second')).status).toBe(200)

      const [key] = await db
        .select()
        .from(wrappedKeysTable)
        .where(and(eq(wrappedKeysTable.userId, p('u')), eq(wrappedKeysTable.keyId, '1')))
      expect(key.wrappedKey).toBe('first') // mint-only: the second POST is a no-op
      const [metadata] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, p('u')))
      expect(metadata.primaryKeyId).toBe('1') // setPrimary applied in the same tx
    })

    it('POST rejects an untrusted device (before proof verification)', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u')) // pending

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/keys`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('d')),
          body: JSON.stringify({
            keyId: '1',
            wrappedKey: 'w',
            proof: { signature: 's', nonce: 'n', operation: 'rotate', deviceId: p('d') },
          }),
        }),
      )
      expect(res.status).toBe(403)
    })

    it('POST rejects a mint without a valid challenge proof', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('d'), p('u'), { trusted: true })

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/keys`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('d')),
          body: JSON.stringify({
            keyId: '1',
            wrappedKey: 'w',
            setPrimary: true,
            proof: { signature: 'bad', nonce: 'nope', operation: 'rotate', deviceId: p('d') },
          }),
        }),
      )
      expect(res.status).toBe(403)

      // Nothing was written — the mint is gated behind proof verification.
      const keys = await db
        .select()
        .from(wrappedKeysTable)
        .where(eq(wrappedKeysTable.userId, p('u')))
      expect(keys).toHaveLength(0)
    })
  })

  // ─── AK rotation ────────────────────────────────────────────────────

  describe('POST /devices/me/cancel-pending', () => {
    const pendingFlag = async (deviceId: string) => {
      const [row] = await db.select().from(devicesTable).where(eq(devicesTable.id, deviceId))
      return row.approvalPending
    }

    const cancel = (deviceId: string, body?: { pendingSince?: string }) =>
      app.handle(
        new Request(`${baseUrl}/devices/me/cancel-pending`, {
          method: 'POST',
          headers: authHeaders(p('tok'), deviceId),
          body: JSON.stringify(body ?? {}),
        }),
      )

    it('cancels the pending request when the token matches', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'))

      const res = await cancel(p('d'), { pendingSince: now.toISOString() })

      expect(res.status).toBe(204)
      expect(await pendingFlag(p('d'))).toBe(false)
    })

    it('leaves a newer pending request alone when the token is stale', async () => {
      // Regression: the cancel is fired without awaiting it, so a slow one used
      // to land after the user retried and wipe the FRESH request — the retry
      // vanished and the approving device showed "Request denied".
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'))
      const staleToken = new Date(now.getTime() - 60_000).toISOString()

      const res = await cancel(p('d'), { pendingSince: staleToken })

      expect(res.status).toBe(409)
      expect(await pendingFlag(p('d'))).toBe(true)
    })

    it('cancels unconditionally when no token is supplied', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'))

      const res = await cancel(p('d'))

      expect(res.status).toBe(204)
      expect(await pendingFlag(p('d'))).toBe(false)
    })

    it('returns the pendingSince token on registration', async () => {
      await createUserAndSession(p('u'), p('tok'))

      const res = await app.handle(
        new Request(`${baseUrl}/devices`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('d')),
          body: JSON.stringify({ deviceId: p('d'), publicKey: 'pk', mlkemPublicKey: 'mlkem-pk' }),
        }),
      )

      expect(res.status).toBe(200)
      const registered = (await res.json()) as { trusted: boolean; pendingSince?: string }
      expect(registered.trusted).toBe(false)
      expect(registered.pendingSince).toBeTruthy()

      // The freshly-issued token cancels; a stale one does not.
      expect((await cancel(p('d'), { pendingSince: registered.pendingSince })).status).toBe(204)
    })
  })

  describe('GET /encryption/envelope-targets', () => {
    it('returns exactly the devices a rotation must cover, with their public keys', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertDevice(p('peer'), p('u'), { trusted: true })
      // Excluded: cannot hold an envelope, or must not receive the new AK.
      await insertDevice(p('bridge'), p('u'), { trusted: true, keyless: true })
      await insertDevice(p('pending'), p('u'), { trusted: false })
      await insertDevice(p('revoked'), p('u'), { trusted: true, revokedAt: now })

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/envelope-targets`, { headers: authHeaders(p('tok'), p('caller')) }),
      )

      expect(res.status).toBe(200)
      const { devices } = (await res.json()) as {
        devices: Array<{ device_id: string; public_key: string; mlkem_public_key: string }>
      }
      expect(devices.map((device) => device.device_id).sort()).toEqual([p('caller'), p('peer')].sort())
      expect(devices[0].public_key).toBe('pk-test')
      expect(devices[0].mlkem_public_key).toBe('mlkem-pk-test')
    })

    it('rejects a revoked caller', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertDevice(p('d'), p('u'), { trusted: true, revokedAt: now })

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/envelope-targets`, { headers: authHeaders(p('tok'), p('d')) }),
      )
      expect(res.status).toBe(403)
    })
  })

  describe('POST /encryption/rotate', () => {
    const setupRotatable = async (keyIds: string[]) => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertEnvelope(p('caller'), p('u'))
      for (const keyId of keyIds) {
        await insertWrappedKeyRow(p('u'), keyId)
      }
      return keypair
    }

    const rotateBody = async (keypair: CryptoKeyPair, keyIds: string[]) => ({
      proof: await proofFor(p('tok'), p('caller'), 'rotate', keypair),
      envelopes: [{ deviceId: p('caller'), wrappedCK: 'new-ak' }],
      wrappedKeys: keyIds.map((keyId) => ({ keyId, wrappedKey: `rewrapped-${keyId}` })),
      canaryIv: 'new-iv',
      canaryCtext: 'new-ctext',
      signingPublicKey: await exportSigningPublicKey(keypair),
      kdfSalt: 'new-salt',
      ...recoverySlot,
    })

    it('re-wraps the full keyring and bumps key_version', async () => {
      const keypair = await setupRotatable([initialKeyId])
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await rotateBody(keypair, [initialKeyId])),
        }),
      )
      expect(res.status).toBe(200)
      expect((await res.json()).key_version).toBe(2)

      const [key] = await db
        .select()
        .from(wrappedKeysTable)
        .where(and(eq(wrappedKeysTable.userId, p('u')), eq(wrappedKeysTable.keyId, initialKeyId)))
      expect(key.wrappedKey).toBe(`rewrapped-${initialKeyId}`)
    })

    it('does not require an envelope for a trusted keyless device (bridge)', async () => {
      // Regression: coverage used to demand an envelope for EVERY trusted device.
      // A bridge has no public keys, so the client cannot wrap one — every
      // rotation and upgrade on such an account failed with 400 forever.
      const keypair = await setupRotatable([initialKeyId])
      await insertDevice(p('bridge'), p('u'), { trusted: true, keyless: true })

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await rotateBody(keypair, [initialKeyId])),
        }),
      )

      expect(res.status).toBe(200)
    })

    it('still requires an envelope for a trusted device that has keys', async () => {
      const keypair = await setupRotatable([initialKeyId])
      await insertDevice(p('peer'), p('u'), { trusted: true })

      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await rotateBody(keypair, [initialKeyId])),
        }),
      )

      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain(p('peer'))
    })

    it('re-covers the "v1" slot on an absorbed account (N5)', async () => {
      const keypair = await setupRotatable([initialKeyId, legacyKeyId])
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await rotateBody(keypair, [initialKeyId, legacyKeyId])),
        }),
      )
      expect(res.status).toBe(200)

      const [v1] = await db
        .select()
        .from(wrappedKeysTable)
        .where(and(eq(wrappedKeysTable.userId, p('u')), eq(wrappedKeysTable.keyId, legacyKeyId)))
      expect(v1.wrappedKey).toBe(`rewrapped-${legacyKeyId}`)
    })

    it('rejects a keyring missing an existing key_id (coverage validation)', async () => {
      const keypair = await setupRotatable([initialKeyId, legacyKeyId])
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await rotateBody(keypair, [initialKeyId])), // omits "v1"
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain(legacyKeyId)
    })

    it('rejects envelopes missing a trusted device (coverage validation)', async () => {
      const keypair = await setupRotatable([initialKeyId])
      await insertDevice(p('other'), p('u'), { trusted: true })
      await insertEnvelope(p('other'), p('u'))

      const body = await rotateBody(keypair, [initialKeyId]) // envelopes only cover caller, not "other"
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(body),
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('every envelope-capable device')
    })

    it('re-anchors the recovery slot to the same phrase on a silent rotation', async () => {
      const keypair = await setupRotatable([initialKeyId])
      const body = await rotateBody(keypair, [initialKeyId])
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ ...body, recoveryWrappedAK: 'recovery-wrapped-new-ak' }),
        }),
      )
      expect(res.status).toBe(200)

      const [metadata] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, p('u')))
      expect(metadata.recoveryEcdhPublicKey).toBe(recoverySlot.recoveryEcdhPublicKey)
      expect(metadata.recoveryWrappedAk).toBe('recovery-wrapped-new-ak')
    })

    it('accepts CHANGED recovery public keys — that is an explicit phrase change', async () => {
      const keypair = await setupRotatable([initialKeyId])
      const body = await rotateBody(keypair, [initialKeyId])
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/rotate`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({
            ...body,
            recoveryEcdhPublicKey: 'fresh-phrase-ecdh',
            recoveryMlkemPublicKey: 'fresh-phrase-mlkem',
            recoveryWrappedAK: 'fresh-phrase-wrapped-ak',
          }),
        }),
      )
      expect(res.status).toBe(200)

      const [metadata] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, p('u')))
      expect(metadata.recoveryEcdhPublicKey).toBe('fresh-phrase-ecdh')
      expect(metadata.recoveryMlkemPublicKey).toBe('fresh-phrase-mlkem')
      expect(metadata.recoveryWrappedAk).toBe('fresh-phrase-wrapped-ak')
    })

    it.each(['recoveryEcdhPublicKey', 'recoveryMlkemPublicKey', 'recoveryWrappedAK'] as const)(
      'rejects a rotation with a blank %s (partial recovery triple)',
      async (field) => {
        const keypair = await setupRotatable([initialKeyId])
        const body = await rotateBody(keypair, [initialKeyId])
        const res = await app.handle(
          new Request(`${baseUrl}/encryption/rotate`, {
            method: 'POST',
            headers: authHeaders(p('tok'), p('caller')),
            body: JSON.stringify({ ...body, [field]: '' }),
          }),
        )
        expect(res.status).toBe(400)
        expect((await res.json()).error).toContain('must be supplied together')
      },
    )

    it.each(['recoveryEcdhPublicKey', 'recoveryMlkemPublicKey', 'recoveryWrappedAK'] as const)(
      'rejects a rotation omitting %s entirely',
      async (field) => {
        const keypair = await setupRotatable([initialKeyId])
        const { [field]: _omitted, ...body } = await rotateBody(keypair, [initialKeyId])
        const res = await app.handle(
          new Request(`${baseUrl}/encryption/rotate`, {
            method: 'POST',
            headers: authHeaders(p('tok'), p('caller')),
            body: JSON.stringify(body),
          }),
        )
        expect(res.status).toBe(422)
      },
    )
  })

  // ─── v1→v2 upgrade ──────────────────────────────────────────────────

  describe('POST /encryption/upgrade', () => {
    const canarySecret = 'the-v1-content-key-canary-secret'

    const setupV1 = async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), 'unused', {
        schemeVersion: 1,
        signingKeyNull: true,
        canarySecretHash: await hashSecret(canarySecret),
      })
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertEnvelope(p('caller'), p('u'))
    }

    const upgradeBody = async (overrides: Record<string, unknown> = {}) => {
      const keypair = await generateSigningKeypair()
      return {
        nonce: await issueNonce(p('tok'), p('caller'), 'upgrade'),
        possessionProof: canarySecret,
        envelopes: [{ deviceId: p('caller'), wrappedCK: 'new-ak' }],
        wrappedKeys: [
          { keyId: initialKeyId, wrappedKey: 'fresh-dek-0' },
          { keyId: legacyKeyId, wrappedKey: 'absorbed-v1-ck' },
        ],
        primaryKeyId: initialKeyId,
        canaryIv: 'v2-iv',
        canaryCtext: 'v2-ctext',
        signingPublicKey: await exportSigningPublicKey(keypair),
        kdfSalt: 'v2-salt',
        ...recoverySlot,
        ...overrides,
      }
    }

    it('flips scheme 1→2, persists keyring "0"+"v1", and registers the signing key', async () => {
      await setupV1()
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await upgradeBody()),
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scheme_version).toBe(2)
      expect(body.key_version).toBe(2)

      const [metadata] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(eq(encryptionMetadataTable.userId, p('u')))
      expect(metadata.schemeVersion).toBe(2)
      expect(metadata.signingPublicKey).not.toBeNull()
      expect(metadata.recoveryEcdhPublicKey).toBe(recoverySlot.recoveryEcdhPublicKey)
      expect(metadata.recoveryMlkemPublicKey).toBe(recoverySlot.recoveryMlkemPublicKey)
      expect(metadata.recoveryWrappedAk).toBe(recoverySlot.recoveryWrappedAK)
      const keys = await db
        .select()
        .from(wrappedKeysTable)
        .where(eq(wrappedKeysTable.userId, p('u')))
      expect(keys.map((k) => k.keyId).sort()).toEqual([initialKeyId, legacyKeyId].sort())
    })

    it('rejects a wrong possession proof (D1)', async () => {
      await setupV1()
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await upgradeBody({ possessionProof: 'not-the-canary-secret' })),
        }),
      )
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('Invalid CK-possession proof')
    })

    it('rejects a keyring missing the fresh primary "0"', async () => {
      await setupV1()
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(
            await upgradeBody({
              wrappedKeys: [
                { keyId: legacyKeyId, wrappedKey: 'absorbed' },
                { keyId: 'ws1', wrappedKey: 'w' },
              ],
            }),
          ),
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain(initialKeyId)
    })

    it('rejects a keyring missing the "v1" slot', async () => {
      await setupV1()
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(
            await upgradeBody({
              wrappedKeys: [
                { keyId: initialKeyId, wrappedKey: 'fresh' },
                { keyId: 'ws1', wrappedKey: 'w' },
              ],
            }),
          ),
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain(legacyKeyId)
    })

    it('rejects envelopes missing a trusted device', async () => {
      await setupV1()
      await insertDevice(p('other'), p('u'), { trusted: true })
      await insertEnvelope(p('other'), p('u'))
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await upgradeBody()), // envelopes only cover caller
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('every envelope-capable device')
    })

    it('a second concurrent migrator loses the CAS (409)', async () => {
      await setupV1()
      const first = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await upgradeBody()),
        }),
      )
      expect(first.status).toBe(200)

      // Second upgrade with a fresh nonce but the account is already scheme 2.
      const second = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await upgradeBody()),
        }),
      )
      expect(second.status).toBe(409)
    })

    it('rejects a replayed / unknown upgrade nonce', async () => {
      await setupV1()
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await upgradeBody({ nonce: 'never-issued-nonce' })),
        }),
      )
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('Invalid or expired upgrade nonce')
    })

    it('rejects an upgrade with a partial recovery triple', async () => {
      await setupV1()
      const res = await app.handle(
        new Request(`${baseUrl}/encryption/upgrade`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify(await upgradeBody({ recoveryWrappedAK: '' })),
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('must be supplied together')
    })
  })

  // ─── deny (challenge proof) ─────────────────────────────────────────

  describe('POST /devices/:deviceId/deny', () => {
    it('denies a pending device with a valid proof', async () => {
      const keypair = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertDevice(p('target'), p('u'))

      const proof = await proofFor(p('tok'), p('caller'), 'deny', keypair)
      const res = await app.handle(
        new Request(`${baseUrl}/devices/${p('target')}/deny`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ proof }),
        }),
      )
      expect(res.status).toBe(204)
      const [target] = await db
        .select()
        .from(devicesTable)
        .where(eq(devicesTable.id, p('target')))
      expect(target.approvalPending).toBe(false)
    })

    it('rejects deny with a forged proof', async () => {
      const keypair = await generateSigningKeypair()
      const attacker = await generateSigningKeypair()
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), await exportSigningPublicKey(keypair))
      await insertDevice(p('caller'), p('u'), { trusted: true })
      await insertDevice(p('target'), p('u'))

      const proof = await proofFor(p('tok'), p('caller'), 'deny', attacker)
      const res = await app.handle(
        new Request(`${baseUrl}/devices/${p('target')}/deny`, {
          method: 'POST',
          headers: authHeaders(p('tok'), p('caller')),
          body: JSON.stringify({ proof }),
        }),
      )
      expect(res.status).toBe(403)
    })
  })

  // ─── canary metadata (v2 shape) ─────────────────────────────────────

  describe('GET /encryption/canary — v2 metadata', () => {
    it('returns the full EncryptionMetadataResponse for a v2 account', async () => {
      const keypair = await generateSigningKeypair()
      const signingPublicKey = await exportSigningPublicKey(keypair)
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), signingPublicKey)

      const res = await app.handle(new Request(`${baseUrl}/encryption/canary`, { headers: authHeaders(p('tok')) }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scheme_version).toBe(2)
      expect(body.primary_key_id).toBe(initialKeyId)
      expect(body.key_version).toBe(1)
      expect(body.signing_public_key).toBe(signingPublicKey)
      expect(body.kdf_salt).toBe('salt-test')
      expect(body.recovery_ecdh_public_key).toBe(recoverySlot.recoveryEcdhPublicKey)
      expect(body.recovery_mlkem_public_key).toBe(recoverySlot.recoveryMlkemPublicKey)
      expect(body.recovery_wrapped_ak).toBe(recoverySlot.recoveryWrappedAK)
    })

    it('returns null recovery fields for a pre-flip v1 account', async () => {
      await createUserAndSession(p('u'), p('tok'))
      await insertV2Metadata(p('u'), 'unused', { schemeVersion: 1, signingKeyNull: true })

      const res = await app.handle(new Request(`${baseUrl}/encryption/canary`, { headers: authHeaders(p('tok')) }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.scheme_version).toBe(1)
      expect(body.recovery_ecdh_public_key).toBeNull()
      expect(body.recovery_mlkem_public_key).toBeNull()
      expect(body.recovery_wrapped_ak).toBeNull()
    })
  })
})
