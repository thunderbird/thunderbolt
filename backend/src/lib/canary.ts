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

/**
 * E2EE v2 challenge-response verification (replaces the v1 static canary
 * secret): the client proves possession of the account signing key by signing
 * `nonce ‖ operation ‖ deviceId` (SHARED encoder — see @shared/e2ee-types)
 * with the ECDSA P-256 key deterministically derived from the canary secret.
 * The server stores only the public key (base64 SPKI, `signing_public_key`)
 * and single-use nonces.
 */

/**
 * Verify an ECDSA challenge proof for a trust-sensitive operation.
 *
 * Steps (all fail closed):
 * 1. Consume the nonce — a single atomic UPDATE rejects replay and expiry.
 *    Consumption happens before signature verification, so a failed attempt
 *    burns the nonce (the client simply fetches a fresh one).
 * 2. Check the nonce row's binding matches BOTH the proof fields and the
 *    caller-supplied expectations (operation + deviceId + userId).
 * 3. Verify the P-256/SHA-256 signature over the shared payload encoding
 *    against the stored `signing_public_key`. Missing metadata or a NULL
 *    signing key (v1 leftover) rejects.
 *
 * Signatures are base64, IEEE P1363 (raw r||s) as produced by WebCrypto/noble.
 */
export const verifyChallengeProof = async (
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
