/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { challengeNoncesTable, encryptionMetadataTable, envelopesTable, wrappedKeysTable } from '@/db/schema'
import type { ChallengeOperation } from '@shared/e2ee-types'
import { and, eq, gt, lte, or, sql } from 'drizzle-orm'

// ─── Envelopes ────────────────────────────────────────────────────────
// NOTE (v2): the `wrapped_ck` column now carries the ACCOUNT KEY (AK), not the
// old Content Key. The column/field name is kept to avoid migration churn.

/** Get an envelope by device ID and user ID. `wrappedCk` carries the AK (v2). */
export const getEnvelopeByDeviceId = async (database: typeof DbType, deviceId: string, userId: string) =>
  database
    .select({ wrappedCk: envelopesTable.wrappedCk })
    .from(envelopesTable)
    .where(and(eq(envelopesTable.deviceId, deviceId), eq(envelopesTable.userId, userId)))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Check if any envelopes exist for a user. */
export const hasEnvelopesForUser = async (database: typeof DbType, userId: string) =>
  database
    .select({ deviceId: envelopesTable.deviceId })
    .from(envelopesTable)
    .where(eq(envelopesTable.userId, userId))
    .limit(1)
    .then((rows) => rows.length > 0)

/** Upsert an envelope for a device. Only updates if userId matches (defense-in-depth). */
export const upsertEnvelope = async (
  database: typeof DbType,
  envelope: { deviceId: string; userId: string; wrappedCk: string },
) =>
  database
    .insert(envelopesTable)
    .values({
      deviceId: envelope.deviceId,
      userId: envelope.userId,
      wrappedCk: envelope.wrappedCk,
    })
    .onConflictDoUpdate({
      target: envelopesTable.deviceId,
      set: { wrappedCk: envelope.wrappedCk, updatedAt: new Date() },
      setWhere: eq(envelopesTable.userId, envelope.userId),
    })

/** Delete an envelope for a device. Scoped by userId to prevent cross-user deletion. */
export const deleteEnvelope = async (database: typeof DbType, deviceId: string, userId: string) =>
  database.delete(envelopesTable).where(and(eq(envelopesTable.deviceId, deviceId), eq(envelopesTable.userId, userId)))

/** Delete every envelope for a user (beta reset, A9). */
export const deleteAllEnvelopesForUser = async (database: typeof DbType, userId: string) =>
  database.delete(envelopesTable).where(eq(envelopesTable.userId, userId))

// ─── Encryption metadata ──────────────────────────────────────────────

/** Get encryption metadata for a user (canary + signing key + KDF salt + keyring pointers). */
export const getEncryptionMetadata = async (database: typeof DbType, userId: string) =>
  database
    .select({
      canaryIv: encryptionMetadataTable.canaryIv,
      canaryCtext: encryptionMetadataTable.canaryCtext,
      signingPublicKey: encryptionMetadataTable.signingPublicKey,
      kdfSalt: encryptionMetadataTable.kdfSalt,
      keyVersion: encryptionMetadataTable.keyVersion,
      primaryKeyId: encryptionMetadataTable.primaryKeyId,
    })
    .from(encryptionMetadataTable)
    .where(eq(encryptionMetadataTable.userId, userId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** Insert encryption metadata for a user. Idempotent — does nothing if row already exists. */
export const insertEncryptionMetadataIfNotExists = async (
  database: typeof DbType,
  metadata: { userId: string; canaryIv: string; canaryCtext: string; signingPublicKey?: string; kdfSalt?: string },
) =>
  database
    .insert(encryptionMetadataTable)
    .values(metadata)
    .onConflictDoNothing({ target: encryptionMetadataTable.userId })

/**
 * Replace canary + signing key + KDF salt in one UPDATE (AK rotation, A5).
 * key_version is bumped separately via bumpKeyVersion inside the same transaction.
 */
export const replaceEncryptionMetadata = async (
  database: typeof DbType,
  metadata: { userId: string; canaryIv: string; canaryCtext: string; signingPublicKey: string; kdfSalt: string },
) =>
  database
    .update(encryptionMetadataTable)
    .set({
      canaryIv: metadata.canaryIv,
      canaryCtext: metadata.canaryCtext,
      signingPublicKey: metadata.signingPublicKey,
      kdfSalt: metadata.kdfSalt,
    })
    .where(eq(encryptionMetadataTable.userId, metadata.userId))
    .returning()

/** Increment key_version (signals devices to refresh their AK envelope). Returns the new version. */
export const bumpKeyVersion = async (database: typeof DbType, userId: string) =>
  database
    .update(encryptionMetadataTable)
    .set({ keyVersion: sql`${encryptionMetadataTable.keyVersion} + 1` })
    .where(eq(encryptionMetadataTable.userId, userId))
    .returning()
    .then((rows) => rows[0]?.keyVersion ?? null)

/** Point all new writes at a different DEK (DEK rotation / workspace DEK promotion). */
export const setPrimaryKeyId = async (database: typeof DbType, userId: string, keyId: string) =>
  database
    .update(encryptionMetadataTable)
    .set({ primaryKeyId: keyId })
    .where(eq(encryptionMetadataTable.userId, userId))

/** Delete encryption metadata for a user (beta reset, A9). */
export const deleteEncryptionMetadata = async (database: typeof DbType, userId: string) =>
  database.delete(encryptionMetadataTable).where(eq(encryptionMetadataTable.userId, userId))

// ─── Wrapped keys (versioned DEK keyring) ─────────────────────────────

/** Get one wrapped DEK by (userId, keyId). */
export const getWrappedKey = async (database: typeof DbType, userId: string, keyId: string) =>
  database
    .select({ keyId: wrappedKeysTable.keyId, wrappedKey: wrappedKeysTable.wrappedKey })
    .from(wrappedKeysTable)
    .where(and(eq(wrappedKeysTable.userId, userId), eq(wrappedKeysTable.keyId, keyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/** List the full wrapped-DEK keyring for a user. */
export const listWrappedKeys = async (database: typeof DbType, userId: string) =>
  database
    .select({ keyId: wrappedKeysTable.keyId, wrappedKey: wrappedKeysTable.wrappedKey })
    .from(wrappedKeysTable)
    .where(eq(wrappedKeysTable.userId, userId))

/**
 * Insert a NEW wrapped DEK — used ONLY to mint a new key_id (setup / DEK
 * rotation / workspace DEK). ON CONFLICT DO NOTHING makes it idempotent per
 * (key_id, user_id).
 *
 * INVARIANT: the DEK material for a key_id is immutable; its AK-wrapping is
 * mutable and MUST change on every AK rotation. AK-rotation re-wrap must NEVER
 * route through this function — DO NOTHING would silently drop the re-wrap and
 * strand devices once the old AK is discarded. Use updateWrappedKey instead.
 */
export const insertWrappedKey = async (
  database: typeof DbType,
  entry: { userId: string; keyId: string; wrappedKey: string },
) =>
  database
    .insert(wrappedKeysTable)
    .values(entry)
    .onConflictDoNothing({ target: [wrappedKeysTable.keyId, wrappedKeysTable.userId] })

/**
 * Overwrite the AK-wrapping of an EXISTING key_id (AK-rotation re-wrap, A5).
 * A plain UPDATE — returns the updated rows so callers can detect a missing
 * key_id (0 rows) and abort the rotation transaction.
 */
export const updateWrappedKey = async (database: typeof DbType, userId: string, keyId: string, wrappedKey: string) =>
  database
    .update(wrappedKeysTable)
    .set({ wrappedKey, updatedAt: new Date() })
    .where(and(eq(wrappedKeysTable.userId, userId), eq(wrappedKeysTable.keyId, keyId)))
    .returning()

/** Delete the full wrapped-DEK keyring for a user (beta reset, A9). */
export const deleteAllWrappedKeysForUser = async (database: typeof DbType, userId: string) =>
  database.delete(wrappedKeysTable).where(eq(wrappedKeysTable.userId, userId))

// ─── Challenge nonces ─────────────────────────────────────────────────

/** Generate a 32-byte base64url nonce. */
const generateNonce = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Issue a single-use challenge nonce bound to (user, operation, device).
 * Returns the nonce and its expiry for the ChallengeResponse DTO.
 */
export const issueChallengeNonce = async (
  database: typeof DbType,
  params: { userId: string; operation: ChallengeOperation; deviceId: string; ttlMs: number },
) => {
  const nonce = generateNonce()
  const expiresAt = new Date(Date.now() + params.ttlMs)
  await database.insert(challengeNoncesTable).values({
    nonce,
    userId: params.userId,
    operation: params.operation,
    deviceId: params.deviceId,
    expiresAt,
  })
  return { nonce, expiresAt }
}

/**
 * Consume a challenge nonce exactly once. The single UPDATE with
 * `consumed = false AND expires_at > now()` in the WHERE makes replay and
 * expiry rejection atomic — a second consume (or a late one) matches 0 rows.
 * Returns the nonce binding for the caller to verify, or null when
 * unknown/replayed/expired.
 */
export const consumeChallengeNonce = async (database: typeof DbType, nonce: string) =>
  database
    .update(challengeNoncesTable)
    .set({ consumed: true })
    .where(
      and(
        eq(challengeNoncesTable.nonce, nonce),
        eq(challengeNoncesTable.consumed, false),
        gt(challengeNoncesTable.expiresAt, new Date()),
      ),
    )
    .returning()
    .then((rows) =>
      rows[0] ? { userId: rows[0].userId, operation: rows[0].operation, deviceId: rows[0].deviceId } : null,
    )

/** Sweep expired or consumed nonces (A7 — startup + hourly interval). */
export const deleteExpiredOrConsumedNonces = async (database: typeof DbType) =>
  database
    .delete(challengeNoncesTable)
    .where(or(eq(challengeNoncesTable.consumed, true), lte(challengeNoncesTable.expiresAt, new Date())))
