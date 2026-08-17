/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { consumeChallengeNonce, getEncryptionMetadata } from '@/dal'
import type { db as DbType } from '@/db/client'
import {
  type ChallengeOperation,
  type ChallengeProof,
  ecdsaKeyAlgorithm,
  ecdsaSignAlgorithm,
  encodeChallengePayload,
  signingPublicKeyFormat,
} from '@shared/e2ee-types'
import { timingSafeEqual } from 'crypto'

/**
 * E2EE v2 device-management gate. Two distinct proofs live here:
 *
 * 1. `verifyChallengeSignature` — the POST-FLIP gate for every trust-sensitive
 *    operation (approve/deny/revoke/rotate/recover). The client signs
 *    `nonce ‖ operation ‖ deviceId` (SHARED encoder, `@shared/e2ee-types`) with
 *    the ECDSA P-256 key deterministically derived from the canary secret; the
 *    server stores only the SPKI public key and single-use nonces.
 *
 * 2. `hashCanarySecret` / `verifyPossessionProof` — the D1 possession anchor for
 *    the BOOTSTRAP `/upgrade` op only. Pre-flip the signing key does not exist,
 *    so `/upgrade` cannot be signature-gated; instead the migrator proves it
 *    holds the v1 CK by presenting the `canarySecret` it recovered by
 *    CK-decrypting the stored canary, verified against the RETAINED
 *    `canary_secret_hash`.
 */

/** Hash a canary secret using SHA-256. Returns hex-encoded hash (matches the v1 storage format). */
export const hashCanarySecret = async (secret: string): Promise<string> => {
  const encoded = new TextEncoder().encode(secret)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Timing-safe compare of a canary secret against a stored SHA-256 hex hash. */
const verifyAgainstHash = async (canarySecret: string, storedHash: string): Promise<boolean> => {
  const hashBuf = Buffer.from(await hashCanarySecret(canarySecret))
  const storedBuf = Buffer.from(storedHash)
  if (hashBuf.length !== storedBuf.length) {
    return false
  }
  return timingSafeEqual(hashBuf, storedBuf)
}

/**
 * D1 CK-possession proof for `/upgrade` (fail-closed): verify the migrator's
 * recovered `canarySecret` against the retained `canary_secret_hash`. Only a
 * device holding the v1 CK can decrypt the canary and produce this secret, so a
 * stolen session (no CK) cannot pass — it cannot install an attacker AK.
 * Rejects when no metadata or no stored hash exists.
 */
export const verifyPossessionProof = async (
  db: typeof DbType,
  userId: string,
  canarySecret: string,
): Promise<boolean> => {
  const metadata = await getEncryptionMetadata(db, userId)
  if (!metadata?.canarySecretHash) {
    return false
  }
  return verifyAgainstHash(canarySecret, metadata.canarySecretHash)
}

/**
 * Verify an ECDSA challenge signature for a trust-sensitive operation.
 *
 * Steps (all fail closed):
 * 1. Consume the nonce — a single atomic UPDATE rejects replay and expiry.
 *    Consumption happens before signature verification, so a failed attempt
 *    burns the nonce (the client simply fetches a fresh one).
 * 2. Check the nonce row's binding matches BOTH the proof fields and the
 *    caller-supplied expectations (operation + deviceId + userId).
 * 3. Verify the P-256/SHA-256 signature over the shared payload encoding
 *    against the stored `signing_public_key`. Missing metadata or a NULL
 *    signing key (pre-flip v1 account) rejects.
 *
 * Signatures are base64, IEEE P1363 (raw r‖s) as produced by WebCrypto/noble.
 */
export const verifyChallengeSignature = async (
  db: typeof DbType,
  userId: string,
  proof: ChallengeProof,
  expectedOperation: ChallengeOperation,
  expectedDeviceId: string,
): Promise<boolean> => {
  const nonceRow = await consumeChallengeNonce(db, proof.nonce)
  if (!nonceRow || nonceRow.userId !== userId) {
    return false
  }
  if (nonceRow.operation !== proof.operation || proof.operation !== expectedOperation) {
    return false
  }
  if (nonceRow.deviceId !== proof.deviceId || proof.deviceId !== expectedDeviceId) {
    return false
  }

  const metadata = await getEncryptionMetadata(db, userId)
  if (!metadata?.signingPublicKey) {
    return false
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      signingPublicKeyFormat,
      Buffer.from(metadata.signingPublicKey, 'base64'),
      ecdsaKeyAlgorithm,
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      publicKey,
      Buffer.from(proof.signature, 'base64'),
      // Copy into a fresh Uint8Array so TS narrows the backing buffer to ArrayBuffer (BufferSource).
      new Uint8Array(encodeChallengePayload(proof.nonce, proof.operation, proof.deviceId)),
    )
  } catch {
    // Malformed public key or signature bytes — reject rather than throw.
    return false
  }
}
