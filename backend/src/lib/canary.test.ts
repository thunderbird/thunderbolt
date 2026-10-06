/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user as userTable } from '@/db/auth-schema'
import { challengeNoncesTable, encryptionMetadataTable } from '@/db/encryption-schema'
import { createTestDb } from '@/test-utils/db'
import { exportSigningPublicKey, generateSigningKeypair, signChallenge } from '@/test-utils/e2ee'
import type { ChallengeOperation } from '@shared/e2ee-types'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { hashCanarySecret, verifyChallengeSignature, verifyPossessionProof } from './canary'

const counterKey = Symbol.for('canary-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

describe('lib/canary', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let userId: string
  let keypair: CryptoKeyPair
  let signingPublicKey: string
  const deviceId = 'device-1'

  const seedNonce = async (nonce: string, operation: ChallengeOperation, boundDeviceId = deviceId, ttlMs = 60_000) => {
    await db.insert(challengeNoncesTable).values({
      nonce,
      userId,
      operation,
      deviceId: boundDeviceId,
      expiresAt: new Date(Date.now() + ttlMs),
      consumed: false,
      createdAt: new Date(),
    })
  }

  const insertMetadata = async (opts: { signingPublicKey?: string | null; canarySecretHash?: string } = {}) => {
    await db.insert(encryptionMetadataTable).values({
      userId,
      canaryIv: 'iv',
      canaryCtext: 'ctext',
      canarySecretHash: opts.canarySecretHash ?? null,
      signingPublicKey: opts.signingPublicKey === undefined ? signingPublicKey : opts.signingPublicKey,
      kdfSalt: 'salt',
      schemeVersion: 2,
      createdAt: new Date(),
    })
  }

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    userId = `canary-${rid}-user`
    const now = new Date()
    await db.insert(userTable).values({
      id: userId,
      name: 'U',
      email: `${userId}@test.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    keypair = await generateSigningKeypair()
    signingPublicKey = await exportSigningPublicKey(keypair)
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  describe('verifyChallengeSignature', () => {
    it('accepts a valid signature and consumes the nonce', async () => {
      await insertMetadata()
      await seedNonce('n1', 'approve')
      const signature = await signChallenge(keypair.privateKey, 'n1', 'approve', deviceId)
      const ok = await verifyChallengeSignature(
        db,
        userId,
        { signature, nonce: 'n1', operation: 'approve', deviceId },
        'approve',
        deviceId,
      )
      expect(ok).toBe(true)
      // Nonce is now consumed → a replay fails.
      const replay = await verifyChallengeSignature(
        db,
        userId,
        { signature, nonce: 'n1', operation: 'approve', deviceId },
        'approve',
        deviceId,
      )
      expect(replay).toBe(false)
    })

    it('rejects a forged signature (fail-closed)', async () => {
      await insertMetadata()
      await seedNonce('n2', 'approve')
      const attacker = await generateSigningKeypair()
      const signature = await signChallenge(attacker.privateKey, 'n2', 'approve', deviceId)
      const ok = await verifyChallengeSignature(
        db,
        userId,
        { signature, nonce: 'n2', operation: 'approve', deviceId },
        'approve',
        deviceId,
      )
      expect(ok).toBe(false)
    })

    it('rejects when the operation does not match the nonce binding', async () => {
      await insertMetadata()
      await seedNonce('n3', 'approve')
      const signature = await signChallenge(keypair.privateKey, 'n3', 'deny', deviceId)
      const ok = await verifyChallengeSignature(
        db,
        userId,
        { signature, nonce: 'n3', operation: 'deny', deviceId },
        'deny',
        deviceId,
      )
      expect(ok).toBe(false)
    })

    it('rejects when the deviceId does not match the nonce binding', async () => {
      await insertMetadata()
      await seedNonce('n4', 'approve', 'other-device')
      const signature = await signChallenge(keypair.privateKey, 'n4', 'approve', deviceId)
      const ok = await verifyChallengeSignature(
        db,
        userId,
        { signature, nonce: 'n4', operation: 'approve', deviceId },
        'approve',
        deviceId,
      )
      expect(ok).toBe(false)
    })

    it('rejects an expired nonce', async () => {
      await insertMetadata()
      await seedNonce('n5', 'approve', deviceId, -1000)
      const signature = await signChallenge(keypair.privateKey, 'n5', 'approve', deviceId)
      const ok = await verifyChallengeSignature(
        db,
        userId,
        { signature, nonce: 'n5', operation: 'approve', deviceId },
        'approve',
        deviceId,
      )
      expect(ok).toBe(false)
    })

    it('rejects when the account has no signing key (pre-flip v1)', async () => {
      await insertMetadata({ signingPublicKey: null })
      await seedNonce('n6', 'approve')
      const signature = await signChallenge(keypair.privateKey, 'n6', 'approve', deviceId)
      const ok = await verifyChallengeSignature(
        db,
        userId,
        { signature, nonce: 'n6', operation: 'approve', deviceId },
        'approve',
        deviceId,
      )
      expect(ok).toBe(false)
    })
  })

  describe('verifyPossessionProof', () => {
    it('accepts the canary secret that matches the stored hash', async () => {
      const secret = 'the-content-key-secret'
      await insertMetadata({ signingPublicKey: null, canarySecretHash: await hashCanarySecret(secret) })
      expect(await verifyPossessionProof(db, userId, secret)).toBe(true)
    })

    it('rejects a wrong canary secret', async () => {
      await insertMetadata({ signingPublicKey: null, canarySecretHash: await hashCanarySecret('real') })
      expect(await verifyPossessionProof(db, userId, 'wrong')).toBe(false)
    })

    it('rejects when no canary_secret_hash is stored', async () => {
      await insertMetadata({ signingPublicKey: null })
      expect(await verifyPossessionProof(db, userId, 'anything')).toBe(false)
    })
  })
})
