/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user as userTable } from '@/db/auth-schema'
import { encryptionMetadataTable } from '@/db/encryption-schema'
import { createTestDb } from '@/test-utils/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  consumeChallengeNonce,
  deleteExpiredOrConsumedNonces,
  flipSchemeToV2,
  getEncryptionMetadata,
  getWrappedKey,
  insertWrappedKey,
  issueChallengeNonce,
  listWrappedKeys,
  updateWrappedKey,
} from './encryption'
import { challengeNoncesTable } from '@/db/encryption-schema'

const counterKey = Symbol.for('dal-encryption-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

describe('DAL: encryption', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let userId: string

  beforeEach(async () => {
    const rid = ++(globalThis as Record<symbol, number>)[counterKey]
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    userId = `dal-enc-${rid}-user`
    const now = new Date()
    await db.insert(userTable).values({
      id: userId,
      name: 'U',
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
    it('insertWrappedKey is mint-only (ON CONFLICT DO NOTHING)', async () => {
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'first' })
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'second' })
      const key = await getWrappedKey(db, userId, '0')
      expect(key?.wrappedKey).toBe('first')
    })

    it('updateWrappedKey overwrites an existing key and returns the row', async () => {
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'first' })
      const updated = await updateWrappedKey(db, userId, '0', 'rewrapped')
      expect(updated).toHaveLength(1)
      const key = await getWrappedKey(db, userId, '0')
      expect(key?.wrappedKey).toBe('rewrapped')
    })

    it('updateWrappedKey matches 0 rows for an unknown key_id', async () => {
      const updated = await updateWrappedKey(db, userId, 'nope', 'x')
      expect(updated).toHaveLength(0)
    })

    it('listWrappedKeys returns the full keyring', async () => {
      await insertWrappedKey(db, { userId, keyId: '0', wrappedKey: 'a' })
      await insertWrappedKey(db, { userId, keyId: 'v1', wrappedKey: 'b' })
      const keys = await listWrappedKeys(db, userId)
      expect(keys.map((k) => k.keyId).sort()).toEqual(['0', 'v1'])
    })
  })

  describe('challenge nonces', () => {
    it('consumeChallengeNonce returns the binding exactly once', async () => {
      const { nonce } = await issueChallengeNonce(db, { userId, operation: 'approve', deviceId: 'd1', ttlMs: 60_000 })
      const first = await consumeChallengeNonce(db, nonce)
      expect(first).toEqual({ userId, operation: 'approve', deviceId: 'd1' })
      const second = await consumeChallengeNonce(db, nonce)
      expect(second).toBeNull()
    })

    it('consumeChallengeNonce rejects an expired nonce', async () => {
      const { nonce } = await issueChallengeNonce(db, { userId, operation: 'rotate', deviceId: 'd1', ttlMs: -1000 })
      expect(await consumeChallengeNonce(db, nonce)).toBeNull()
    })

    it('deleteExpiredOrConsumedNonces sweeps consumed and expired rows', async () => {
      const live = await issueChallengeNonce(db, { userId, operation: 'approve', deviceId: 'd1', ttlMs: 60_000 })
      const expired = await issueChallengeNonce(db, { userId, operation: 'approve', deviceId: 'd1', ttlMs: -1000 })
      await consumeChallengeNonce(db, live.nonce) // mark consumed
      await deleteExpiredOrConsumedNonces(db)
      const remaining = await db.select().from(challengeNoncesTable).where(eq(challengeNoncesTable.userId, userId))
      expect(remaining.map((r) => r.nonce)).not.toContain(live.nonce)
      expect(remaining.map((r) => r.nonce)).not.toContain(expired.nonce)
    })
  })

  describe('metadata + scheme flip', () => {
    const insertV1Metadata = async () => {
      await db.insert(encryptionMetadataTable).values({
        userId,
        canaryIv: 'iv',
        canaryCtext: 'ctext',
        canarySecretHash: 'hash',
        schemeVersion: 1,
        createdAt: new Date(),
      })
    }

    it('getEncryptionMetadata returns the v2 shape incl. retained canarySecretHash', async () => {
      await insertV1Metadata()
      const metadata = await getEncryptionMetadata(db, userId)
      expect(metadata?.schemeVersion).toBe(1)
      expect(metadata?.primaryKeyId).toBe('0')
      expect(metadata?.keyVersion).toBe(1)
      expect(metadata?.canarySecretHash).toBe('hash')
      expect(metadata?.signingPublicKey).toBeNull()
    })

    it('flipSchemeToV2 CAS succeeds once and returns null on a second flip', async () => {
      await insertV1Metadata()
      const flip = () =>
        flipSchemeToV2(db, {
          userId,
          canaryIv: 'v2-iv',
          canaryCtext: 'v2-ctext',
          signingPublicKey: 'spki',
          kdfSalt: 'salt',
          primaryKeyId: '0',
        })

      const first = await flip()
      expect(first?.schemeVersion).toBe(2)
      expect(first?.keyVersion).toBe(2)

      const second = await flip()
      expect(second).toBeNull()

      const [row] = await db
        .select()
        .from(encryptionMetadataTable)
        .where(and(eq(encryptionMetadataTable.userId, userId)))
      expect(row.schemeVersion).toBe(2)
      expect(row.signingPublicKey).toBe('spki')
    })
  })
})
