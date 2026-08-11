/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { insertEncryptionMetadataIfNotExists, issueChallengeNonce } from '@/dal'
import { user } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { exportSigningPublicKey, generateSigningKeypair, signChallenge } from '@/test-utils/e2ee'
import type { ChallengeOperation, ChallengeProof } from '@shared/e2ee-types'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { verifyChallengeProof } from './canary'

const counterKey = Symbol.for('canary-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

describe('verifyChallengeProof', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let p: (id: string) => string
  let userId: string
  let deviceId: string
  let keypair: CryptoKeyPair

  const insertUser = async (id: string) => {
    const now = new Date()
    await db.insert(user).values({
      id,
      name: 'Test User',
      email: `${id}@test.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  const insertMetadataWithKey = async (targetUserId: string, publicKey?: string | null) => {
    await insertEncryptionMetadataIfNotExists(db, {
      userId: targetUserId,
      canaryIv: 'iv',
      canaryCtext: 'ct',
      ...(publicKey !== null ? { signingPublicKey: publicKey ?? (await exportSigningPublicKey(keypair)) } : {}),
      kdfSalt: 'salt',
    })
  }

  /** Issue a nonce and sign it with the given private key (defaults to the account keypair). */
  const makeProof = async (
    operation: ChallengeOperation,
    options: { forUserId?: string; forDeviceId?: string; signWith?: CryptoKey; ttlMs?: number } = {},
  ): Promise<ChallengeProof> => {
    const boundUserId = options.forUserId ?? userId
    const boundDeviceId = options.forDeviceId ?? deviceId
    const { nonce } = await issueChallengeNonce(db, {
      userId: boundUserId,
      operation,
      deviceId: boundDeviceId,
      ttlMs: options.ttlMs ?? 60_000,
    })
    const signature = await signChallenge(options.signWith ?? keypair.privateKey, nonce, operation, boundDeviceId)
    return { signature, nonce, operation, deviceId: boundDeviceId }
  }

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `${rid}-${id}`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    userId = p('u1')
    deviceId = p('d1')
    keypair = await generateSigningKeypair()
    await insertUser(userId)
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  it('accepts a valid, fresh proof', async () => {
    await insertMetadataWithKey(userId)
    const proof = await makeProof('approve')

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(true)
  })

  it('rejects a replayed proof (nonce consumed on first use)', async () => {
    await insertMetadataWithKey(userId)
    const proof = await makeProof('approve')

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(true)
    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it('rejects an expired nonce', async () => {
    await insertMetadataWithKey(userId)
    const proof = await makeProof('approve', { ttlMs: -1000 })

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it('rejects a wrong operation (nonce bound to a different op)', async () => {
    await insertMetadataWithKey(userId)
    // Nonce issued for 'deny' but the caller expects 'revoke'
    const proof = await makeProof('deny')

    expect(await verifyChallengeProof(db, userId, proof, 'revoke', deviceId)).toBe(false)
  })

  it('rejects a proof whose operation field disagrees with the nonce binding', async () => {
    await insertMetadataWithKey(userId)
    const proof = await makeProof('deny')

    // Tamper the proof operation to match the expectation — nonce row disagrees
    const tampered = {
      ...proof,
      operation: 'revoke' as const,
      signature: await signChallenge(keypair.privateKey, proof.nonce, 'revoke', deviceId),
    }
    expect(await verifyChallengeProof(db, userId, tampered, 'revoke', deviceId)).toBe(false)
  })

  it('rejects a wrong device (nonce bound to another device)', async () => {
    await insertMetadataWithKey(userId)
    const proof = await makeProof('approve', { forDeviceId: p('other-device') })

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it("rejects another user's nonce", async () => {
    const otherUserId = p('u2')
    await insertUser(otherUserId)
    await insertMetadataWithKey(userId)
    const proof = await makeProof('approve', { forUserId: otherUserId })

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it('rejects a tampered payload (signature does not verify)', async () => {
    await insertMetadataWithKey(userId)
    const { nonce } = await issueChallengeNonce(db, { userId, operation: 'approve', deviceId, ttlMs: 60_000 })
    // Signed over a DIFFERENT nonce than the one submitted
    const signature = await signChallenge(keypair.privateKey, 'some-other-nonce', 'approve', deviceId)
    const proof: ChallengeProof = { signature, nonce, operation: 'approve', deviceId }

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it('rejects a signature from the wrong keypair', async () => {
    await insertMetadataWithKey(userId)
    const attackerKeypair = await generateSigningKeypair()
    const proof = await makeProof('approve', { signWith: attackerKeypair.privateKey })

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it('fails closed when no encryption metadata exists', async () => {
    const proof = await makeProof('approve')

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it('fails closed on a v1 row (metadata exists, signing key NULL)', async () => {
    await insertMetadataWithKey(userId, null)
    const proof = await makeProof('approve')

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })

  it('rejects malformed base64 key/signature without throwing', async () => {
    await insertEncryptionMetadataIfNotExists(db, {
      userId,
      canaryIv: 'iv',
      canaryCtext: 'ct',
      signingPublicKey: 'not-a-valid-spki-key',
      kdfSalt: 'salt',
    })
    const proof = await makeProof('approve')

    expect(await verifyChallengeProof(db, userId, proof, 'approve', deviceId)).toBe(false)
  })
})
