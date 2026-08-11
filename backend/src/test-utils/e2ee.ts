/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  type ChallengeOperation,
  ecdsaKeyAlgorithm,
  ecdsaSignAlgorithm,
  encodeChallengePayload,
  signingPublicKeyFormat,
} from '@shared/e2ee-types'

/**
 * Test helpers for E2EE v2 challenge-response: generate a P-256 keypair,
 * export the public key the way clients upload it (base64 SPKI), and sign
 * challenge payloads through the SHARED encoder so tests exercise the exact
 * byte layout the backend verifies.
 */

/** Generate an ECDSA P-256 signing keypair (the client derives this from the canary secret). */
export const generateSigningKeypair = () => crypto.subtle.generateKey(ecdsaKeyAlgorithm, true, ['sign', 'verify'])

/** Export the signing public key as base64 SPKI — the `signing_public_key` storage format. */
export const exportSigningPublicKey = async (keypair: CryptoKeyPair) =>
  Buffer.from(await crypto.subtle.exportKey(signingPublicKeyFormat, keypair.publicKey)).toString('base64')

/** Sign a challenge payload (via the shared encoder) — returns the base64 P1363 signature. */
export const signChallenge = async (
  privateKey: CryptoKey,
  nonce: string,
  operation: ChallengeOperation,
  deviceId: string,
) =>
  Buffer.from(
    await crypto.subtle.sign(
      ecdsaSignAlgorithm,
      privateKey,
      new Uint8Array(encodeChallengePayload(nonce, operation, deviceId)),
    ),
  ).toString('base64')
