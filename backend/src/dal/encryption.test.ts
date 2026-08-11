/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { challengeNoncesTable } from '@/db/encryption-schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  bumpKeyVersion,
  consumeChallengeNonce,
  deleteExpiredOrConsumedNonces,
  getEncryptionMetadata,
  getWrappedKey,
  insertEncryptionMetadataIfNotExists,
  insertWrappedKey,
  issueChallengeNonce,
  listWrappedKeys,
  replaceEncryptionMetadata,
  setPrimaryKeyId,
  updateWrappedKey,
} from './encryption'

const counterKey = Symbol.for('dal-encryption-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

describe('encryption DAL', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let p: (id: string) => string
  let userId: string

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    p = (id: string) => `${rid}-${id}`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup

    userId = p('dal-enc-user')
    const now = new Date()
    await db.insert(user).values({
      id: userId,
      name: 'DAL User',
      email: `${userId}@test.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  describe('wrapped keys', () => {
    it('insertWrappedKey twice for the same (key_id, user_id) is a no-op (DO NOTHING)', async () => {
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'original' })
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'attacker-overwrite' })

      const key = await getWrappedKey(db, userId, '0')
      expect(key?.wrappedKey).toBe('original')

      const all = await listWrappedKeys(db, userId)
      expect(all).toHaveLength(1)
    })

    it('updateWrappedKey overwrites the wrapped bytes (AK-rotation re-wrap)', async () => {
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'wrapped-under-old-ak' })

      const updated = await updateWrappedKey(db, userId, '0', 'wrapped-under-new-ak')
      expect(updated).toHaveLength(1)

      const key = await getWrappedKey(db, userId, '0')
      expect(key?.wrappedKey).toBe('wrapped-under-new-ak')
    })

    it('updateWrappedKey on a missing key_id matches 0 rows', async () => {
      const updated = await updateWrappedKey(db, userId, 'missing', 'x')
      expect(updated).toHaveLength(0)
    })

    it('listWrappedKeys returns the full keyring scoped to the user', async () => {
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'wk-0' })
      await insertWrappedKey(db, { userId, keyId: '1', wrappedKey: 'wk-1' })

      const keys = await listWrappedKeys(db, userId)
      expect(keys.map((k) => k.keyId).sort()).toEqual(['0', '1'])
    })
  })

  describe('challenge nonces', () => {
    it('consumes a nonce exactly once, then rejects the replay', async () => {
      const { nonce, expiresAt } = await issueChallengeNonce(db, {
        userId,
        operation: 'approve',
        deviceId: p('d1'),
        ttlMs: 60_000,
      })
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now())

      const first = await consumeChallengeNonce(db, nonce)
      expect(first).toEqual({ userId, operation: 'approve', deviceId: p('d1') })

      const replay = await consumeChallengeNonce(db, nonce)
      expect(replay).toBeNull()
    })

    it('rejects an expired nonce', async () => {
      const { nonce } = await issueChallengeNonce(db, {
        userId,
        operation: 'rotate',
        deviceId: p('d1'),
        ttlMs: -1000,
      })

      const consumed = await consumeChallengeNonce(db, nonce)
      expect(consumed).toBeNull()
    })

    it('rejects an unknown nonce', async () => {
      const consumed = await consumeChallengeNonce(db, 'never-issued')
      expect(consumed).toBeNull()
    })

    it('deleteExpiredOrConsumedNonces removes consumed and expired rows, keeps live ones', async () => {
      const consumed = await issueChallengeNonce(db, { userId, operation: 'deny', deviceId: p('d1'), ttlMs: 60_000 })
      await consumeChallengeNonce(db, consumed.nonce)
      const expired = await issueChallengeNonce(db, { userId, operation: 'deny', deviceId: p('d1'), ttlMs: -1000 })
      const live = await issueChallengeNonce(db, { userId, operation: 'deny', deviceId: p('d1'), ttlMs: 60_000 })

      await deleteExpiredOrConsumedNonces(db)

      const remaining = await db.select().from(challengeNoncesTable).where(eq(challengeNoncesTable.userId, userId))
      expect(remaining.map((row) => row.nonce)).toEqual([live.nonce])
      expect(remaining.map((row) => row.nonce)).not.toContain(consumed.nonce)
      expect(remaining.map((row) => row.nonce)).not.toContain(expired.nonce)
    })
  })

  describe('encryption metadata', () => {
    it('insert + reshape read returns signing key, kdf salt, and keyring pointers', async () => {
      await insertEncryptionMetadataIfNotExists(db, {
        userId,
        canaryIv: 'iv',
        canaryCtext: 'ct',
        signingPublicKey: 'spki-b64',
        kdfSalt: 'salt-b64',
      })

      const metadata = await getEncryptionMetadata(db, userId)
      expect(metadata).toEqual({
        canaryIv: 'iv',
        canaryCtext: 'ct',
        signingPublicKey: 'spki-b64',
        kdfSalt: 'salt-b64',
        keyVersion: 1,
        primaryKeyId: '0',
      })
    })

    it('replaceEncryptionMetadata swaps canary + signing key + kdf salt; bumpKeyVersion increments', async () => {
      await insertEncryptionMetadataIfNotExists(db, {
        userId,
        canaryIv: 'iv',
        canaryCtext: 'ct',
        signingPublicKey: 'old-key',
        kdfSalt: 'old-salt',
      })

      await replaceEncryptionMetadata(db, {
        userId,
        canaryIv: 'new-iv',
        canaryCtext: 'new-ct',
        signingPublicKey: 'new-key',
        kdfSalt: 'new-salt',
      })
      const version = await bumpKeyVersion(db, userId)
      expect(version).toBe(2)

      const metadata = await getEncryptionMetadata(db, userId)
      expect(metadata?.canaryIv).toBe('new-iv')
      expect(metadata?.signingPublicKey).toBe('new-key')
      expect(metadata?.kdfSalt).toBe('new-salt')
      expect(metadata?.keyVersion).toBe(2)
    })

    it('setPrimaryKeyId moves the primary pointer', async () => {
      await insertEncryptionMetadataIfNotExists(db, { userId, canaryIv: 'iv', canaryCtext: 'ct' })

      await setPrimaryKeyId(db, userId, '1')

      const metadata = await getEncryptionMetadata(db, userId)
      expect(metadata?.primaryKeyId).toBe('1')
    })

    it('bumpKeyVersion returns null when no metadata exists', async () => {
      expect(await bumpKeyVersion(db, p('nobody'))).toBeNull()
    })
  })
})
