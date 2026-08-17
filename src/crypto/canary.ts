/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { p256 } from '@noble/curves/nist.js'
import {
  canaryAAD,
  ecdsaKeyAlgorithm,
  encodeChallengePayload,
  type ChallengeOperation,
  type KeyId,
} from '@shared/e2ee-types'

import { DecryptionError, KeyDerivationError } from './errors'
import { decrypt, encrypt, uint8ArrayToBase64 } from './primitives'

/** v2 canary plaintext prefix — encrypted under the primary DEK with `canaryAAD`. */
const canaryPrefix = 'thunderbolt-canary-v2'
/**
 * v1 canary plaintext prefix — the absorbed legacy CK decrypts it with NO AAD.
 * Only `recoverCanarySecretV1` reads this (the D1 upgrade possession proof).
 */
const canaryPrefixV1 = 'thunderbolt-canary-v1'
const secretLength = 32 // bytes

const signingHkdfInfo = new TextEncoder().encode('thunderbolt-signing-v1')
// P-256 seed width required by noble's bias-free hash-to-scalar reduction
// (getMinHashLength(n) = 48 — see @noble/curves mapHashToField).
const signingSeedLength = 48

type Canary = {
  canaryIv: string
  canaryCtext: string
  canarySecret: string
}

type CanaryVerification = {
  valid: boolean
  canarySecret?: string
}

export type SigningKeyPair = {
  /** P-256 private scalar — never leaves the client. */
  privateKey: Uint8Array
  /** Base64 SPKI public key (`signingPublicKeyFormat`) for the server to verify against. */
  publicKeySpki: string
}

/** Generate a random hex secret for the canary. */
const generateCanarySecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(secretLength))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Create a canary by encrypting a known prefix + random secret under a DEK,
 * bound to `canaryAAD(userId, keyId)` (Track 0 single source of truth). In
 * practice every caller anchors the canary to DEK `"0"` / `canaryAAD(userId,
 * "0")` — DEK "0" is retained forever, so `verifyCanary` always decrypts and a
 * lone DEK rotation never orphans it. Do NOT parameterize this on the *current*
 * primary key_id: that would break cross-device verify after a DEK rotation.
 */
export const createCanary = async (primaryDek: CryptoKey, userId: string, keyId: KeyId): Promise<Canary> => {
  const canarySecret = generateCanarySecret()
  const plaintext = `${canaryPrefix}:${canarySecret}`
  const { iv, ciphertext } = await encrypt(plaintext, primaryDek, canaryAAD(userId, keyId))
  return { canaryIv: iv, canaryCtext: ciphertext, canarySecret }
}

/**
 * Verify key material by decrypting the canary (bound to `canaryAAD(userId,
 * keyId)`) and comparing to the known prefix. Returns the embedded secret on
 * success — it seeds the deterministic signing keypair for challenge-response.
 */
export const verifyCanary = async (
  primaryDek: CryptoKey,
  userId: string,
  keyId: KeyId,
  canaryIv: string,
  canaryCtext: string,
): Promise<CanaryVerification> => {
  try {
    const decrypted = await decrypt({ iv: canaryIv, ciphertext: canaryCtext }, primaryDek, canaryAAD(userId, keyId))
    if (!decrypted.startsWith(`${canaryPrefix}:`)) {
      return { valid: false }
    }
    return { valid: true, canarySecret: decrypted.slice(canaryPrefix.length + 1) }
  } catch (err) {
    if (err instanceof DecryptionError) {
      return { valid: false }
    }
    throw err
  }
}

/**
 * D1 upgrade possession proof — recover the `canarySecret` by a v1-style decrypt
 * of the stored canary with the absorbed legacy CK and NO AAD (matching how v1
 * wrote it). DISTINCT from `verifyCanary`: at upgrade time no primary DEK or
 * `canaryAAD` exists yet. The recovered secret is sent to `/upgrade`, where the
 * server checks `hash(canarySecret) == canary_secret_hash` (proof the caller
 * holds the CK). Returns the secret, or null when the CK cannot decrypt it.
 */
export const recoverCanarySecretV1 = async (
  legacyCK: CryptoKey,
  canaryIv: string,
  canaryCtext: string,
): Promise<string | null> => {
  try {
    const decrypted = await decrypt({ iv: canaryIv, ciphertext: canaryCtext }, legacyCK)
    if (!decrypted.startsWith(`${canaryPrefixV1}:`)) {
      return null
    }
    return decrypted.slice(canaryPrefixV1.length + 1)
  } catch (err) {
    if (err instanceof DecryptionError) {
      return null
    }
    throw err
  }
}

/**
 * Deterministically derive the ECDSA P-256 signing keypair from the canary
 * secret: HKDF-SHA256(canarySecret, info 'thunderbolt-signing-v1') → 48 bytes →
 * noble's bias-free scalar reduction. WebCrypto can't seed-derive EC keys, so
 * signing goes through noble; the public key is exported as base64 SPKI so the
 * backend verifies via plain `crypto.subtle.verify`.
 */
export const deriveSigningKeyPair = async (canarySecret: string): Promise<SigningKeyPair> => {
  try {
    const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(canarySecret), 'HKDF', false, [
      'deriveBits',
    ])
    const seed = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: signingHkdfInfo },
        ikm,
        signingSeedLength * 8,
      ),
    )
    const privateKey = p256.utils.randomSecretKey(seed)
    const publicKeyRaw = p256.getPublicKey(privateKey, false)
    const publicKey = await crypto.subtle.importKey('raw', publicKeyRaw as BufferSource, ecdsaKeyAlgorithm, true, [
      'verify',
    ])
    const spki = await crypto.subtle.exportKey('spki', publicKey)
    return { privateKey, publicKeySpki: uint8ArrayToBase64(new Uint8Array(spki)) }
  } catch (err) {
    throw new KeyDerivationError('Failed to derive signing keypair', { cause: err })
  }
}

/**
 * Sign a challenge for proof-of-key-possession: ECDSA P-256 over SHA-256 of the
 * shared `encodeChallengePayload(nonce, operation, deviceId)` byte layout.
 * Emits base64 IEEE P1363 (raw r||s) — exactly what the backend's
 * `crypto.subtle.verify` expects.
 */
export const signChallenge = async (
  canarySecret: string,
  nonce: string,
  operation: ChallengeOperation,
  deviceId: string,
): Promise<string> => {
  const { privateKey } = await deriveSigningKeyPair(canarySecret)
  const payload = encodeChallengePayload(nonce, operation, deviceId)
  const signature = p256.sign(payload, privateKey)
  return uint8ArrayToBase64(signature)
}
