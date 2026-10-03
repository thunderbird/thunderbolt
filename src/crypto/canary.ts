/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { p256 } from '@noble/curves/nist.js'
import {
  akCanaryAnchor,
  canaryAAD,
  ecdsaKeyAlgorithm,
  ecdsaSignAlgorithm,
  encodeChallengePayload,
  encodeRecoveryAttestationPayload,
  signingPublicKeyFormat,
  type ChallengeOperation,
} from '@shared/e2ee-types'

import { DecryptionError, KeyDerivationError } from './errors'
import { aesGcmAlgorithm, base64ToUint8Array, decrypt, ivLength, uint8ArrayToBase64 } from './primitives'

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
  /** The unwrap of the EXACT bytes in `canaryCtext` — see `mintCanary`. */
  canaryKey: CryptoKey
}

export type SigningKeyPair = {
  /** P-256 private scalar — never leaves the client. */
  privateKey: Uint8Array
  /** Base64 SPKI public key (`signingPublicKeyFormat`) for the server to verify against. */
  publicKeySpki: string
}

/** The AES-GCM params binding a canary blob to this account's AK anchor. */
const canaryWrapParams = (iv: Uint8Array, userId: string) =>
  ({
    name: aesGcmAlgorithm,
    iv: iv as BufferSource,
    additionalData: canaryAAD(userId, akCanaryAnchor) as BufferSource,
  }) as const

/**
 * Mint a fresh canary: a random 32-byte seed wrapped UNDER THE ACCOUNT KEY
 * (THU-872). The AK is replaced on every rotation and never delivered to a
 * revoked device, so the signing keypair derived from this seed is epoch-fresh:
 * a revoked device's retained DEK "0" (the old anchor) no longer derives the
 * current signing identity.
 *
 * Mechanics: HKDF keys cannot be `wrapKey`'d, so the seed rides as an
 * EXTRACTABLE HMAC carrier that exists only inside this function; the returned
 * `canaryKey` is the non-extractable HKDF unwrap of the EXACT blob being
 * returned (single source of truth, mirroring `mintDEK`). Deriving the posted
 * `signingPublicKey` from that handle is what makes the pre-submit round-trip
 * hold by construction: a blob that would not open under this AK cannot
 * produce the key the caller goes on to publish.
 *
 * No plaintext prefix — the GCM tag plus `canaryAAD(userId, '__ak')` is the
 * validity check. The v1 canary (`recoverCanarySecretV1`) is untouched.
 */
export const mintCanary = async (ak: CryptoKey, userId: string): Promise<Canary> => {
  const seed = crypto.getRandomValues(new Uint8Array(secretLength))
  const carrier = await crypto.subtle.importKey('raw', seed as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, true, [
    'sign',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(ivLength))
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', carrier, ak, canaryWrapParams(iv, userId)))
  const canaryIv = uint8ArrayToBase64(iv)
  const canaryCtext = uint8ArrayToBase64(wrapped)
  return { canaryIv, canaryCtext, canaryKey: await unwrapCanaryKey(ak, userId, canaryIv, canaryCtext) }
}

/**
 * Unwrap the served canary blob under the AK into the seed's HKDF handle —
 * non-extractable, deriveBits-only. Succeeding is itself the verification:
 * the GCM tag + AAD prove the blob was minted for THIS account's CURRENT AK
 * epoch, so a historical canary (or one bound to another account) fails loudly
 * with a `DecryptionError`. The seed bytes never surface to script.
 */
export const unwrapCanaryKey = async (
  ak: CryptoKey,
  userId: string,
  canaryIv: string,
  canaryCtext: string,
): Promise<CryptoKey> => {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      base64ToUint8Array(canaryCtext) as BufferSource,
      ak,
      canaryWrapParams(base64ToUint8Array(canaryIv), userId),
      'HKDF',
      false,
      ['deriveBits', 'deriveKey'],
    )
  } catch (err) {
    throw new DecryptionError('Failed to unwrap canary under the account key', { cause: err })
  }
}

/**
 * D1 upgrade possession proof — recover the `canarySecret` by a v1-style decrypt
 * of the stored canary with the absorbed legacy CK and NO AAD (matching how v1
 * wrote it). DISTINCT from `unwrapCanaryKey`: at upgrade time no AK or
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
 * Deterministically derive the ECDSA P-256 signing keypair from the canary key
 * (the unwrapped seed's HKDF handle — see `unwrapCanaryKey`):
 * HKDF-SHA256(seed, info 'thunderbolt-signing-v1') → 48 bytes → noble's
 * bias-free scalar reduction. WebCrypto can't seed-derive EC keys, so signing
 * goes through noble; the public key is exported as base64 SPKI so the backend
 * verifies via plain `crypto.subtle.verify`. Takes the CryptoKey outright — a
 * string overload would be a silent wrong-key footgun.
 */
export const deriveSigningKeyPair = async (canaryKey: CryptoKey): Promise<SigningKeyPair> => {
  try {
    const seed = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: signingHkdfInfo },
        canaryKey,
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
  canaryKey: CryptoKey,
  nonce: string,
  operation: ChallengeOperation,
  deviceId: string,
): Promise<string> => {
  const { privateKey } = await deriveSigningKeyPair(canaryKey)
  const payload = encodeChallengePayload(nonce, operation, deviceId)
  const signature = p256.sign(payload, privateKey)
  return uint8ArrayToBase64(signature)
}

/** The recovery anchor a rotation must authenticate before wrapping the AK to it. */
export type RecoveryAnchor = {
  userId: string
  kdfSalt: string
  recoveryEcdhPublicKey: string
  recoveryMlkemPublicKey: string
}

const encodeAnchor = (anchor: RecoveryAnchor): Uint8Array =>
  encodeRecoveryAttestationPayload(
    anchor.userId,
    anchor.kdfSalt,
    anchor.recoveryEcdhPublicKey,
    anchor.recoveryMlkemPublicKey,
  )

/**
 * Sign the recovery anchor with the signing key derived from THIS write's
 * canary key (THU-865). Called by every path that writes the recovery slot —
 * first-device setup, v1→v2 upgrade, and each AK rotation — so the anchor the
 * server serves is always accompanied by a signature only a keyring holder
 * could have produced.
 */
export const signRecoveryAttestation = async (canaryKey: CryptoKey, anchor: RecoveryAnchor): Promise<string> => {
  const { privateKey } = await deriveSigningKeyPair(canaryKey)
  return uint8ArrayToBase64(p256.sign(encodeAnchor(anchor), privateKey))
}

/**
 * Verify a served recovery anchor against the caller's OWN key material: derive
 * the signing public key from `canaryKey` (itself recovered locally via
 * `unwrapCanaryKey`) and check the signature. A malicious server cannot forge
 * this — it does not hold the AK and so cannot learn the canary seed.
 *
 * The payload is RECONSTRUCTED from `anchor`, never parsed out of the
 * signature's input, which is what keeps the domain separation in
 * `encodeRecoveryAttestationPayload` meaningful.
 *
 * Returns false on malformed key or signature bytes rather than throwing,
 * mirroring the backend's `verifyChallengeSignature`.
 */
export const verifyRecoveryAttestation = async (
  canaryKey: CryptoKey,
  attestation: string,
  anchor: RecoveryAnchor,
): Promise<boolean> => {
  const { publicKeySpki } = await deriveSigningKeyPair(canaryKey)
  try {
    const publicKey = await crypto.subtle.importKey(
      signingPublicKeyFormat,
      base64ToUint8Array(publicKeySpki),
      ecdsaKeyAlgorithm,
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      publicKey,
      base64ToUint8Array(attestation),
      // Copy so TS narrows the backing buffer to ArrayBuffer (BufferSource).
      new Uint8Array(encodeAnchor(anchor)),
    )
  } catch {
    return false
  }
}
