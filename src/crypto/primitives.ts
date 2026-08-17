/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { DecryptionError, EncryptionError } from './errors'

const ecdhAlgorithm = 'ECDH'
const ecdhCurve = 'P-256'
const ephemeralPubKeyLength = 65 // P-256 uncompressed: 0x04 || x (32) || y (32)
const aesGcmAlgorithm = 'AES-GCM'
const aesKwAlgorithm = 'AES-KW'
const aesKeyLength = 256
const ivLength = 12
const hkdfHash = 'SHA-256'

// Hybrid envelope constants — byte layout is a wire contract, never change.
// The envelope is byte-identical between v1 (wrapped CK) and v2 (wrapped AK);
// only the wrapped payload's key type differs, which is why the v1-CK
// absorption unwrap (`unwrapLegacyCK`) can share this derivation. The HKDF info
// string predates the CK→AK rename; changing it would break every existing
// envelope for zero security benefit.
const envelopeVersion = 0x01
const mlkemCiphertextLength = 1088
const aesKwWrappedKeyLength = 40 // AES-KW(256-bit key) = 32 + 8
const minEnvelopeLength = 1 + ephemeralPubKeyLength + mlkemCiphertextLength + aesKwWrappedKeyLength
const hybridHkdfInfo = new TextEncoder().encode('thunderbolt-hybrid-ck-wrap-v1')

const mlkemAtRestHkdfInfo = new TextEncoder().encode('thunderbolt-mlkem-at-rest-v1')

// =============================================================================
// ECDH key pair (for wrapping/unwrapping AK via ECIES)
// =============================================================================

/** Generate an ECDH P-256 key pair for wrapping/unwrapping AK. */
export const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey({ name: ecdhAlgorithm, namedCurve: ecdhCurve }, false, ['deriveBits'])

/** Export a public key to base64 (for sending to the server). */
export const exportPublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const exported = await crypto.subtle.exportKey('raw', publicKey)
  return uint8ArrayToBase64(new Uint8Array(exported))
}

/** Import a public key from base64 (for wrapping AK with another device's key). */
export const importPublicKey = async (base64: string): Promise<CryptoKey> => {
  try {
    return await crypto.subtle.importKey(
      'raw',
      base64ToUint8Array(base64),
      { name: ecdhAlgorithm, namedCurve: ecdhCurve },
      true,
      [],
    )
  } catch (err) {
    throw new EncryptionError('Failed to import public key', { cause: err })
  }
}

// =============================================================================
// ML-KEM-768 key pair (post-quantum, for hybrid wrapping)
// =============================================================================

export type MlKemKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

/** Generate an ML-KEM-768 key pair for hybrid AK wrapping. */
export const generateMlKemKeyPair = (): MlKemKeyPair => {
  const { publicKey, secretKey } = ml_kem768.keygen()
  return { publicKey, secretKey }
}

/** Export an ML-KEM public key to base64. */
export const exportMlKemPublicKey = (publicKey: Uint8Array): string => uint8ArrayToBase64(publicKey)

/** Import an ML-KEM public key from base64. */
export const importMlKemPublicKey = (base64: string): Uint8Array => base64ToUint8Array(base64)

/**
 * Derive the AES-GCM key that encrypts the ML-KEM secret key at rest (THU-427).
 * Self-ECDH (own public + own private) → HKDF-SHA256 — NOT the AK, which would
 * be a circular dependency (the AK envelope needs the ML-KEM secret to unwrap).
 * The ECDH private key is a non-extractable CryptoKey in IndexedDB, so this
 * raises the bar from plaintext-bytes-at-rest.
 */
export const deriveMlKemAtRestKey = async (
  ownEcdhPublicKey: CryptoKey,
  ownEcdhPrivateKey: CryptoKey,
): Promise<CryptoKey> => {
  const shared = await crypto.subtle.deriveBits(
    { name: ecdhAlgorithm, public: ownEcdhPublicKey },
    ownEcdhPrivateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: hkdfHash, salt: new Uint8Array(0), info: mlkemAtRestHkdfInfo },
    hkdfKey,
    { name: aesGcmAlgorithm, length: aesKeyLength },
    false,
    ['encrypt', 'decrypt'],
  )
}

// =============================================================================
// AK (Account Key, AES-KW) + DEK (Data Encryption Key, AES-GCM)
// =============================================================================

/**
 * Generate an Account Key: AES-KW 256, `wrapKey`/`unwrapKey` ONLY — it must be
 * unable to encrypt data (access control, not data encryption).
 * @param extractable - `true` only transiently during setup (the AK must be
 *   extractable to be wrapped into device envelopes). Re-import via
 *   `reimportAsNonExtractable` before storing.
 */
export const generateAK = async (extractable = false): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: aesKwAlgorithm, length: aesKeyLength }, extractable, ['wrapKey', 'unwrapKey'])

/** Re-import an extractable AK as non-extractable. Used after setup wrapping. */
export const reimportAsNonExtractable = async (ak: CryptoKey): Promise<CryptoKey> => {
  const raw = await crypto.subtle.exportKey('raw', ak)
  return crypto.subtle.importKey('raw', raw, { name: aesKwAlgorithm, length: aesKeyLength }, false, [
    'wrapKey',
    'unwrapKey',
  ])
}

/**
 * Generate a Data Encryption Key: AES-256-GCM, `encrypt`/`decrypt`.
 * @param extractable - `true` only transiently at mint time (WebCrypto wrapKey
 *   requires the wrapped key extractable). Prefer `mintDEK`, which never lets
 *   the extractable copy escape.
 */
export const generateDEK = async (extractable = false): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: aesGcmAlgorithm, length: aesKeyLength }, extractable, ['encrypt', 'decrypt'])

/** Wrap a DEK under the AK with AES-KW. The DEK must be extractable at wrap time. */
export const wrapDEK = async (dek: CryptoKey, ak: CryptoKey): Promise<string> => {
  try {
    const wrapped = await crypto.subtle.wrapKey('raw', dek, ak, aesKwAlgorithm)
    return uint8ArrayToBase64(new Uint8Array(wrapped))
  } catch (err) {
    throw new EncryptionError('Failed to wrap DEK', { cause: err })
  }
}

/** Unwrap an AES-KW-wrapped DEK (base64) under the AK. Non-extractable by default. */
export const unwrapDEK = async (wrappedBase64: string, ak: CryptoKey, extractable = false): Promise<CryptoKey> => {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      base64ToUint8Array(wrappedBase64),
      ak,
      aesKwAlgorithm,
      { name: aesGcmAlgorithm, length: aesKeyLength },
      extractable,
      ['encrypt', 'decrypt'],
    )
  } catch (err) {
    throw new DecryptionError('Failed to unwrap DEK', { cause: err })
  }
}

/**
 * Mint a new DEK already wrapped under the AK. The extractable copy exists only
 * inside this function; the returned `dek` is the non-extractable unwrap of the
 * returned `wrappedKey` (single source of truth).
 */
export const mintDEK = async (ak: CryptoKey): Promise<{ dek: CryptoKey; wrappedKey: string }> => {
  const extractableDek = await generateDEK(true)
  const wrappedKey = await wrapDEK(extractableDek, ak)
  const dek = await unwrapDEK(wrappedKey, ak)
  return { dek, wrappedKey }
}

/**
 * Re-wrap an entire DEK keyring under a NEW AK (AK rotation, plan §2.4). Each
 * DEK is unwrapped temporarily-extractable in-memory under the old AK and
 * re-wrapped under the new AK; no persistent extractable copy is ever produced.
 * The set of `keyId`s is preserved exactly — dropping any (esp. the `"v1"` slot)
 * would strand data (Risk 1), so callers validate coverage against this output.
 */
export const rewrapKeyring = async (
  wrappedKeys: Array<{ keyId: string; wrappedKey: string }>,
  oldAK: CryptoKey,
  newAK: CryptoKey,
): Promise<Array<{ keyId: string; wrappedKey: string }>> => {
  try {
    return await Promise.all(
      wrappedKeys.map(async ({ keyId, wrappedKey }) => {
        const tempDek = await unwrapDEK(wrappedKey, oldAK, true)
        return { keyId, wrappedKey: await wrapDEK(tempDek, newAK) }
      }),
    )
  } catch (err) {
    if (err instanceof EncryptionError || err instanceof DecryptionError) {
      throw err
    }
    throw new EncryptionError('Failed to re-wrap keyring', { cause: err })
  }
}

// =============================================================================
// Hybrid ECIES: Wrap / Unwrap AK with ECDH P-256 + ML-KEM-768 + HKDF + AES-KW
//
// Combines a classical ECDH shared secret with an ML-KEM-768 shared secret via
// HKDF, following the combiner pattern from Signal PQXDH and IETF hybrid guidelines.
// Security holds as long as at least one of the two KEMs is unbroken.
// =============================================================================

/**
 * Derive an AES-KW-256 wrapping key from the hybrid shared secrets via HKDF.
 * ikm = ss_ecdh || ss_mlkem (64 bytes combined)
 * salt = ephPubRaw || mlkemCiphertext (binds derivation to both KEM transcripts)
 */
const deriveHybridWrappingKey = async (
  ssEcdh: ArrayBuffer,
  ssMlkem: Uint8Array,
  ephPubRaw: Uint8Array,
  mlkemCiphertext: Uint8Array,
  usage: 'wrapKey' | 'unwrapKey',
): Promise<CryptoKey> => {
  // Concatenate both shared secrets as IKM
  const combinedSS = new Uint8Array(32 + 32)
  combinedSS.set(new Uint8Array(ssEcdh), 0)
  combinedSS.set(ssMlkem, 32)

  // Bind to both KEM transcripts via salt
  const salt = new Uint8Array(ephPubRaw.length + mlkemCiphertext.length)
  salt.set(ephPubRaw, 0)
  salt.set(mlkemCiphertext, ephPubRaw.length)

  const hkdfKey = await crypto.subtle.importKey('raw', combinedSS, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: hkdfHash, salt: salt as BufferSource, info: hybridHkdfInfo },
    hkdfKey,
    { name: aesKwAlgorithm, length: 256 },
    false,
    [usage],
  )
}

/**
 * Wrap AK using hybrid ECDH P-256 + ML-KEM-768.
 * Envelope: [version 1B][ephPubRaw 65B][mlkemCiphertext 1088B][wrappedAK 40B]
 */
export const wrapAK = async (ak: CryptoKey, ecdhPublicKey: CryptoKey, mlkemPublicKey: Uint8Array): Promise<string> => {
  try {
    // Ephemeral ECDH P-256
    const ephemeral = await crypto.subtle.generateKey({ name: ecdhAlgorithm, namedCurve: ecdhCurve }, false, [
      'deriveBits',
    ])
    const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
    const ssEcdh = await crypto.subtle.deriveBits(
      { name: ecdhAlgorithm, public: ecdhPublicKey },
      ephemeral.privateKey,
      256,
    )

    // ML-KEM-768 encapsulate
    const { cipherText: mlkemCiphertext, sharedSecret: ssMlkem } = ml_kem768.encapsulate(mlkemPublicKey)

    // Hybrid HKDF -> AES-KW key
    const wrappingKey = await deriveHybridWrappingKey(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext, 'wrapKey')
    const wrappedAKBytes = new Uint8Array(await crypto.subtle.wrapKey('raw', ak, wrappingKey, aesKwAlgorithm))

    // Assemble versioned envelope
    const envelope = new Uint8Array(1 + ephPubRaw.length + mlkemCiphertext.length + wrappedAKBytes.length)
    envelope[0] = envelopeVersion
    envelope.set(ephPubRaw, 1)
    envelope.set(mlkemCiphertext, 1 + ephPubRaw.length)
    envelope.set(wrappedAKBytes, 1 + ephPubRaw.length + mlkemCiphertext.length)
    return uint8ArrayToBase64(envelope)
  } catch (err) {
    throw new EncryptionError('Failed to wrap account key', { cause: err })
  }
}

/**
 * Rewrap a wrapped AK for a different device's public keys.
 * Unwraps as temporarily extractable (in-memory only), then wraps with target's keys.
 */
export const rewrapAK = async (
  wrappedAKBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
  targetEcdhPublicKey: CryptoKey,
  targetMlkemPublicKey: Uint8Array,
): Promise<string> => {
  try {
    const tempAK = await unwrapAKInternal(wrappedAKBase64, ecdhPrivateKey, mlkemSecretKey, true)
    return wrapAK(tempAK, targetEcdhPublicKey, targetMlkemPublicKey)
  } catch (err) {
    if (err instanceof EncryptionError) {
      throw err
    }
    throw new EncryptionError('Failed to rewrap account key', { cause: err })
  }
}

/** Unwrap AK using hybrid ECDH + ML-KEM. Returns non-extractable AES-KW CryptoKey. */
export const unwrapAK = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<CryptoKey> => unwrapAKInternal(wrappedBase64, ecdhPrivateKey, mlkemSecretKey, false)

/**
 * Parse a hybrid envelope and derive the AES-KW unwrapping key from the ECDH +
 * ML-KEM transcripts. Returns the derived key and the still-wrapped payload
 * bytes. The v1-CK envelope and the v2-AK envelope are byte-identical, so this
 * derivation is shared by both `unwrapAKInternal` and `unwrapLegacyCK`; only the
 * final `crypto.subtle.unwrapKey` (target key type/usages) differs.
 */
const deriveEnvelopeUnwrap = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<{ unwrappingKey: CryptoKey; wrappedKeyBytes: Uint8Array }> => {
  const envelope = base64ToUint8Array(wrappedBase64)

  const version = envelope[0]
  if (version !== envelopeVersion) {
    throw new DecryptionError(`Unsupported envelope version: ${version}`)
  }
  if (envelope.length < minEnvelopeLength) {
    throw new DecryptionError(`Invalid envelope: ${envelope.length} bytes, need >= ${minEnvelopeLength}`)
  }

  let offset = 1
  const ephPubRaw = envelope.slice(offset, offset + ephemeralPubKeyLength)
  offset += ephemeralPubKeyLength
  const mlkemCiphertext = envelope.slice(offset, offset + mlkemCiphertextLength)
  offset += mlkemCiphertextLength
  const wrappedKeyBytes = envelope.slice(offset)

  const ephemeralPublicKey = await crypto.subtle.importKey(
    'raw',
    ephPubRaw,
    { name: ecdhAlgorithm, namedCurve: ecdhCurve },
    false,
    [],
  )
  const ssEcdh = await crypto.subtle.deriveBits(
    { name: ecdhAlgorithm, public: ephemeralPublicKey },
    ecdhPrivateKey,
    256,
  )
  const ssMlkem = ml_kem768.decapsulate(mlkemCiphertext, mlkemSecretKey)
  const unwrappingKey = await deriveHybridWrappingKey(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext, 'unwrapKey')
  return { unwrappingKey, wrappedKeyBytes }
}

/**
 * Internal hybrid unwrap of the AK with configurable extractability.
 * extractable=true is used only in rewrapAK (temporary, in-memory only).
 */
const unwrapAKInternal = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
  extractable: boolean,
): Promise<CryptoKey> => {
  try {
    const { unwrappingKey, wrappedKeyBytes } = await deriveEnvelopeUnwrap(wrappedBase64, ecdhPrivateKey, mlkemSecretKey)
    return await crypto.subtle.unwrapKey(
      'raw',
      wrappedKeyBytes as BufferSource,
      unwrappingKey,
      aesKwAlgorithm,
      { name: aesKwAlgorithm, length: aesKeyLength },
      extractable,
      ['wrapKey', 'unwrapKey'],
    )
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw err
    }
    throw new DecryptionError('Failed to unwrap account key', { cause: err })
  }
}

/**
 * WS3 — legacy CK absorption. Unwrap a v1 device envelope into the legacy
 * content key as an EXTRACTABLE AES-256-GCM key (usages encrypt/decrypt). The
 * envelope is byte-identical to a v2 AK envelope, so this shares
 * `deriveEnvelopeUnwrap`; only the wrapped payload is a CK (AES-GCM) rather than
 * an AK (AES-KW). Runs once, on the migrator, against the server-fetched
 * envelope. The result is extractable so the service layer can (a) `wrapDEK` it
 * into the keyring as the reserved `"v1"` slot and (b) feed it to
 * `recoverCanarySecretV1` for the D1 possession proof.
 */
export const unwrapLegacyCK = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<CryptoKey> => {
  try {
    const { unwrappingKey, wrappedKeyBytes } = await deriveEnvelopeUnwrap(wrappedBase64, ecdhPrivateKey, mlkemSecretKey)
    return await crypto.subtle.unwrapKey(
      'raw',
      wrappedKeyBytes as BufferSource,
      unwrappingKey,
      aesKwAlgorithm,
      { name: aesGcmAlgorithm, length: aesKeyLength },
      true,
      ['encrypt', 'decrypt'],
    )
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw err
    }
    throw new DecryptionError('Failed to unwrap legacy content key', { cause: err })
  }
}

// =============================================================================
// AES-GCM encrypt / decrypt
// =============================================================================

type EncryptedData = {
  iv: string // base64
  ciphertext: string // base64
}

/** Raw-bytes AES-GCM output, used for at-rest encryption in IndexedDB. */
export type EncryptedBytes = {
  iv: Uint8Array
  ciphertext: Uint8Array
}

/**
 * Encrypt plaintext with a DEK using AES-256-GCM. Returns base64-encoded IV and
 * ciphertext. `additionalData` (AAD) is authenticated but not encrypted —
 * decryption fails unless the exact same bytes are supplied. v1 values were
 * written with AAD absent, so the dual-read v1 branch omits it.
 */
export const encrypt = async (
  plaintext: string,
  dek: CryptoKey,
  additionalData?: Uint8Array,
): Promise<EncryptedData> => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const encoded = new TextEncoder().encode(plaintext)
    const ciphertext = await crypto.subtle.encrypt(
      { name: aesGcmAlgorithm, iv, ...(additionalData && { additionalData: additionalData as BufferSource }) },
      dek,
      encoded,
    )
    return {
      iv: uint8ArrayToBase64(iv),
      ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    }
  } catch (err) {
    throw new EncryptionError('Failed to encrypt data', { cause: err })
  }
}

/** Decrypt ciphertext with a DEK using AES-256-GCM. AAD must match the encrypt call. */
export const decrypt = async (data: EncryptedData, dek: CryptoKey, additionalData?: Uint8Array): Promise<string> => {
  try {
    const iv = base64ToUint8Array(data.iv)
    const ciphertext = base64ToUint8Array(data.ciphertext)
    const decrypted = await crypto.subtle.decrypt(
      { name: aesGcmAlgorithm, iv, ...(additionalData && { additionalData: additionalData as BufferSource }) },
      dek,
      ciphertext,
    )
    return new TextDecoder().decode(decrypted)
  } catch (err) {
    throw new DecryptionError('Failed to decrypt data', { cause: err })
  }
}

/** Encrypt raw bytes with AES-256-GCM (at-rest encryption of the ML-KEM secret key). */
export const encryptBytes = async (data: Uint8Array, key: CryptoKey): Promise<EncryptedBytes> => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const ciphertext = await crypto.subtle.encrypt({ name: aesGcmAlgorithm, iv }, key, data as BufferSource)
    return { iv, ciphertext: new Uint8Array(ciphertext) }
  } catch (err) {
    throw new EncryptionError('Failed to encrypt bytes', { cause: err })
  }
}

/** Decrypt raw bytes encrypted by `encryptBytes`. */
export const decryptBytes = async (data: EncryptedBytes, key: CryptoKey): Promise<Uint8Array> => {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: aesGcmAlgorithm, iv: data.iv as BufferSource },
      key,
      data.ciphertext as BufferSource,
    )
    return new Uint8Array(decrypted)
  } catch (err) {
    throw new DecryptionError('Failed to decrypt bytes', { cause: err })
  }
}

// =============================================================================
// Base64 helpers
// =============================================================================

/** Encode bytes as base64 (binary-safe, no Buffer dependency). */
export const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decode a base64 string into bytes. */
export const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Array.from(atob(base64), (c) => c.charCodeAt(0)))
