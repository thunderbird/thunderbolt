/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import {
  challengeNoncesTable,
  encryptionMetadataTable,
  envelopesTable,
  orgEnvelopesTable,
  wrappedKeysTable,
} from '@/db/schema'
import type { ChallengeOperation, KeyId } from '@shared/e2ee-types'
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

// ─── Org-escrow envelopes (THU-804) ───────────────────────────────────

/** Get the org-escrow envelope for a user (the AK wrapped to the operator escrow key). */
export const getOrgEnvelope = async (database: typeof DbType, userId: string) =>
  database
    .select({ wrappedAk: orgEnvelopesTable.wrappedAk, keyFingerprint: orgEnvelopesTable.keyFingerprint })
    .from(orgEnvelopesTable)
    .where(eq(orgEnvelopesTable.userId, userId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/**
 * Upsert the org-escrow envelope for a user. One row per user — every AK
 * change (setup / rotate / upgrade) replaces it inside the same transaction.
 */
export const upsertOrgEnvelope = async (
  database: typeof DbType,
  envelope: { userId: string; wrappedAk: string; keyFingerprint: string },
) =>
  database
    .insert(orgEnvelopesTable)
    .values(envelope)
    .onConflictDoUpdate({
      target: orgEnvelopesTable.userId,
      set: { wrappedAk: envelope.wrappedAk, keyFingerprint: envelope.keyFingerprint, updatedAt: new Date() },
    })

// ─── Encryption metadata ──────────────────────────────────────────────

/**
 * The recovery slot written by every v2 write path: the phrase-derived hybrid
 * PUBLIC keys plus the AK wrapped to them. The recovery phrase is a virtual
 * device, so rotating the AK only needs these public halves — never the phrase.
 */
export type RecoverySlot = {
  recoveryEcdhPublicKey: string
  recoveryMlkemPublicKey: string
  recoveryWrappedAk: string
}

/**
 * Get encryption metadata for a user: the canary, the challenge-response
 * signing public key, the KDF salt, the recovery slot, and the polled keyring
 * pointers (`keyVersion`/`primaryKeyId`/`schemeVersion`). `canarySecretHash` is
 * RETAINED as the v1 CK-possession anchor consumed by `/upgrade` (Decision B).
 */
export const getEncryptionMetadata = async (database: typeof DbType, userId: string) =>
  database
    .select({
      canaryIv: encryptionMetadataTable.canaryIv,
      canaryCtext: encryptionMetadataTable.canaryCtext,
      canarySecretHash: encryptionMetadataTable.canarySecretHash,
      signingPublicKey: encryptionMetadataTable.signingPublicKey,
      kdfSalt: encryptionMetadataTable.kdfSalt,
      recoveryEcdhPublicKey: encryptionMetadataTable.recoveryEcdhPublicKey,
      recoveryMlkemPublicKey: encryptionMetadataTable.recoveryMlkemPublicKey,
      recoveryWrappedAk: encryptionMetadataTable.recoveryWrappedAk,
      keyVersion: encryptionMetadataTable.keyVersion,
      primaryKeyId: encryptionMetadataTable.primaryKeyId,
      schemeVersion: encryptionMetadataTable.schemeVersion,
    })
    .from(encryptionMetadataTable)
    .where(eq(encryptionMetadataTable.userId, userId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

/**
 * Insert v2 first-device-setup metadata. Idempotent — does nothing if a row
 * already exists (so a re-bootstrap can never overwrite an established account).
 * A freshly set-up v2 account has no `canarySecretHash` (that column is a v1
 * artifact); `signingPublicKey`/`kdfSalt`/the recovery slot are always present
 * for v2.
 */
export const insertEncryptionMetadataIfNotExists = async (
  database: typeof DbType,
  metadata: RecoverySlot & {
    userId: string
    canaryIv: string
    canaryCtext: string
    signingPublicKey: string
    kdfSalt: string
    primaryKeyId?: KeyId
  },
) =>
  database
    .insert(encryptionMetadataTable)
    .values({
      userId: metadata.userId,
      canaryIv: metadata.canaryIv,
      canaryCtext: metadata.canaryCtext,
      signingPublicKey: metadata.signingPublicKey,
      kdfSalt: metadata.kdfSalt,
      recoveryEcdhPublicKey: metadata.recoveryEcdhPublicKey,
      recoveryMlkemPublicKey: metadata.recoveryMlkemPublicKey,
      recoveryWrappedAk: metadata.recoveryWrappedAk,
      primaryKeyId: metadata.primaryKeyId ?? undefined,
      schemeVersion: 2,
    })
    .onConflictDoNothing({ target: encryptionMetadataTable.userId })

/**
 * Replace the canary + signing key + KDF salt + recovery slot in one UPDATE (AK
 * rotation). The recovery public keys are unchanged on a silent rotation and
 * differ only when the user explicitly changes their phrase; either way the
 * wrapped AK is re-anchored. `keyVersion` is bumped separately via
 * `bumpKeyVersion` in the same transaction.
 */
export const replaceEncryptionMetadata = async (
  database: typeof DbType,
  metadata: RecoverySlot & {
    userId: string
    canaryIv: string
    canaryCtext: string
    signingPublicKey: string
    kdfSalt: string
  },
) =>
  database
    .update(encryptionMetadataTable)
    .set({
      canaryIv: metadata.canaryIv,
      canaryCtext: metadata.canaryCtext,
      signingPublicKey: metadata.signingPublicKey,
      kdfSalt: metadata.kdfSalt,
      recoveryEcdhPublicKey: metadata.recoveryEcdhPublicKey,
      recoveryMlkemPublicKey: metadata.recoveryMlkemPublicKey,
      recoveryWrappedAk: metadata.recoveryWrappedAk,
    })
    .where(eq(encryptionMetadataTable.userId, metadata.userId))
    .returning()

/**
 * Atomic v1→v2 flip (the LAST step of `/upgrade`, plan §6.1). CAS on
 * `scheme_version = 1`: registers the signing key + KDF salt + recovery slot,
 * re-encrypts the canary under the new primary DEK, points the primary at the
 * new key_id, and bumps `key_version` — all conditional on the row still being
 * scheme 1. Returns the new metadata on success, or `null` when a concurrent
 * migrator already flipped the account (0 rows matched → the caller must 409
 * and roll back).
 */
export const flipSchemeToV2 = async (
  database: typeof DbType,
  metadata: RecoverySlot & {
    userId: string
    canaryIv: string
    canaryCtext: string
    signingPublicKey: string
    kdfSalt: string
    primaryKeyId: KeyId
  },
) =>
  database
    .update(encryptionMetadataTable)
    .set({
      canaryIv: metadata.canaryIv,
      canaryCtext: metadata.canaryCtext,
      signingPublicKey: metadata.signingPublicKey,
      kdfSalt: metadata.kdfSalt,
      recoveryEcdhPublicKey: metadata.recoveryEcdhPublicKey,
      recoveryMlkemPublicKey: metadata.recoveryMlkemPublicKey,
      recoveryWrappedAk: metadata.recoveryWrappedAk,
      primaryKeyId: metadata.primaryKeyId,
      schemeVersion: 2,
      keyVersion: sql`${encryptionMetadataTable.keyVersion} + 1`,
    })
    .where(and(eq(encryptionMetadataTable.userId, metadata.userId), eq(encryptionMetadataTable.schemeVersion, 1)))
    .returning()
    .then((rows) => rows[0] ?? null)

/** Increment key_version (signals devices to refresh their AK envelope). Returns the new version. */
export const bumpKeyVersion = async (database: typeof DbType, userId: string) =>
  database
    .update(encryptionMetadataTable)
    .set({ keyVersion: sql`${encryptionMetadataTable.keyVersion} + 1` })
    .where(eq(encryptionMetadataTable.userId, userId))
    .returning()
    .then((rows) => rows[0]?.keyVersion ?? null)

/** Point all new writes at a different DEK (DEK rotation / workspace DEK promotion). */
export const setPrimaryKeyId = async (database: typeof DbType, userId: string, keyId: KeyId) =>
  database
    .update(encryptionMetadataTable)
    .set({ primaryKeyId: keyId })
    .where(eq(encryptionMetadataTable.userId, userId))

// ─── Wrapped keys (versioned DEK keyring) ─────────────────────────────

/** Get one wrapped DEK by (userId, keyId). */
export const getWrappedKey = async (database: typeof DbType, userId: string, keyId: KeyId) =>
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
 * Insert a NEW wrapped DEK — used ONLY to MINT a new key_id (setup / DEK
 * rotation / workspace DEK / the absorbed `"v1"` slot). `ON CONFLICT DO NOTHING`
 * makes it idempotent per (key_id, user_id).
 *
 * INVARIANT: the DEK material for a key_id is immutable; its AK-wrapping is
 * mutable and MUST change on every AK rotation. AK-rotation re-wrap must NEVER
 * route through this function — DO NOTHING would silently drop the re-wrap and
 * strand devices once the old AK is discarded. Use `updateWrappedKey` instead.
 */
export const insertWrappedKey = async (
  database: typeof DbType,
  entry: { userId: string; keyId: KeyId; wrappedKey: string },
) =>
  database
    .insert(wrappedKeysTable)
    .values(entry)
    .onConflictDoNothing({ target: [wrappedKeysTable.keyId, wrappedKeysTable.userId] })

/**
 * Overwrite the AK-wrapping of an EXISTING key_id (AK-rotation re-wrap). A plain
 * UPDATE — returns the updated rows so callers can detect a missing key_id
 * (0 rows) and abort the rotation transaction.
 */
export const updateWrappedKey = async (database: typeof DbType, userId: string, keyId: KeyId, wrappedKey: string) =>
  database
    .update(wrappedKeysTable)
    .set({ wrappedKey, updatedAt: new Date() })
    .where(and(eq(wrappedKeysTable.userId, userId), eq(wrappedKeysTable.keyId, keyId)))
    .returning()

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

/** Sweep expired or already-consumed nonces (startup + interval, plan Track A A7). */
export const deleteExpiredOrConsumedNonces = async (database: typeof DbType) =>
  database
    .delete(challengeNoncesTable)
    .where(or(eq(challengeNoncesTable.consumed, true), lte(challengeNoncesTable.expiresAt, new Date())))
