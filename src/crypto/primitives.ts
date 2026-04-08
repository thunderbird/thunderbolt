import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { DecryptionError, EncryptionError } from './errors'

const ecdhAlgorithm = 'ECDH'
const ecdhCurve = 'P-256'
const ephemeralPubKeyLength = 65 // P-256 uncompressed: 0x04 || x (32) || y (32)
const aesAlgorithm = 'AES-GCM'
const aesKeyLength = 256
const ivLength = 12
const hkdfHash = 'SHA-256'

// Hybrid envelope constants
const envelopeVersion = 0x01
const mlkemCiphertextLength = 1088
const hybridHkdfInfo = new TextEncoder().encode('thunderbolt-hybrid-ck-wrap-v1')

// =============================================================================
// ECDH key pair (for wrapping/unwrapping CK via ECIES)
// =============================================================================

/** Generate an ECDH P-256 key pair for wrapping/unwrapping CK. */
export const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey({ name: ecdhAlgorithm, namedCurve: ecdhCurve }, false, ['deriveBits'])

/** Export a public key to base64 (for sending to the server). */
export const exportPublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const exported = await crypto.subtle.exportKey('raw', publicKey)
  return uint8ArrayToBase64(new Uint8Array(exported))
}

/** Import a public key from base64 (for wrapping CK with another device's key). */
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

/** Generate an ML-KEM-768 key pair for hybrid CK wrapping. */
export const generateMlKemKeyPair = (): MlKemKeyPair => {
  const { publicKey, secretKey } = ml_kem768.keygen()
  return { publicKey, secretKey }
}

/** Export an ML-KEM public key to base64. */
export const exportMlKemPublicKey = (publicKey: Uint8Array): string => uint8ArrayToBase64(publicKey)

/** Import an ML-KEM public key from base64. */
export const importMlKemPublicKey = (base64: string): Uint8Array => base64ToUint8Array(base64)

// =============================================================================
// AES-256-GCM Content Key (CK)
// =============================================================================

/**
 * Generate an AES-256-GCM content key.
 * @param extractable - Set to `true` only during first device setup (to encode recovery key).
 *   Must be re-imported as non-extractable immediately after.
 */
export const generateCK = async (extractable = false): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: aesAlgorithm, length: aesKeyLength }, extractable, [
    'encrypt',
    'decrypt',
    'wrapKey',
    'unwrapKey',
  ])

/** Re-import an extractable CK as non-extractable. Used after recovery key encoding. */
export const reimportAsNonExtractable = async (ck: CryptoKey): Promise<CryptoKey> => {
  const raw = await crypto.subtle.exportKey('raw', ck)
  return crypto.subtle.importKey('raw', raw, { name: aesAlgorithm, length: aesKeyLength }, false, [
    'encrypt',
    'decrypt',
    'wrapKey',
    'unwrapKey',
  ])
}

// =============================================================================
// Hybrid ECIES: Wrap / Unwrap CK with ECDH P-256 + ML-KEM-768 + HKDF + AES-KW
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
    { name: 'AES-KW', length: 256 },
    false,
    [usage],
  )
}

/**
 * Wrap CK using hybrid ECDH P-256 + ML-KEM-768.
 * Envelope: [version 1B][ephPubRaw 65B][mlkemCiphertext 1088B][wrappedCK 40B]
 */
export const wrapCK = async (ck: CryptoKey, ecdhPublicKey: CryptoKey, mlkemPublicKey: Uint8Array): Promise<string> => {
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
    const wrappedCKBytes = new Uint8Array(await crypto.subtle.wrapKey('raw', ck, wrappingKey, 'AES-KW'))

    // Assemble versioned envelope
    const envelope = new Uint8Array(1 + ephPubRaw.length + mlkemCiphertext.length + wrappedCKBytes.length)
    envelope[0] = envelopeVersion
    envelope.set(ephPubRaw, 1)
    envelope.set(mlkemCiphertext, 1 + ephPubRaw.length)
    envelope.set(wrappedCKBytes, 1 + ephPubRaw.length + mlkemCiphertext.length)
    return uint8ArrayToBase64(envelope)
  } catch (err) {
    throw new EncryptionError('Failed to wrap content key', { cause: err })
  }
}

/**
 * Rewrap a wrapped CK for a different device's public keys.
 * Unwraps as temporarily extractable (in-memory only), then wraps with target's keys.
 */
export const rewrapCK = async (
  wrappedCKBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
  targetEcdhPublicKey: CryptoKey,
  targetMlkemPublicKey: Uint8Array,
): Promise<string> => {
  try {
    const tempCK = await unwrapCKInternal(wrappedCKBase64, ecdhPrivateKey, mlkemSecretKey, true)
    return wrapCK(tempCK, targetEcdhPublicKey, targetMlkemPublicKey)
  } catch (err) {
    if (err instanceof EncryptionError) {
      throw err
    }
    throw new EncryptionError('Failed to rewrap content key', { cause: err })
  }
}

/** Unwrap CK using hybrid ECDH + ML-KEM. Returns non-extractable CryptoKey. */
export const unwrapCK = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
): Promise<CryptoKey> => unwrapCKInternal(wrappedBase64, ecdhPrivateKey, mlkemSecretKey, false)

/**
 * Internal hybrid unwrap with configurable extractability.
 * extractable=true is used only in rewrapCK (temporary, in-memory only).
 */
const unwrapCKInternal = async (
  wrappedBase64: string,
  ecdhPrivateKey: CryptoKey,
  mlkemSecretKey: Uint8Array,
  extractable: boolean,
): Promise<CryptoKey> => {
  try {
    const envelope = base64ToUint8Array(wrappedBase64)

    // Parse versioned envelope
    const version = envelope[0]
    if (version !== envelopeVersion) {
      throw new DecryptionError(`Unsupported envelope version: ${version}`)
    }

    let offset = 1
    const ephPubRaw = envelope.slice(offset, offset + ephemeralPubKeyLength)
    offset += ephemeralPubKeyLength
    const mlkemCiphertext = envelope.slice(offset, offset + mlkemCiphertextLength)
    offset += mlkemCiphertextLength
    const wrappedCKBytes = envelope.slice(offset)

    // ECDH P-256 shared secret
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

    // ML-KEM-768 decapsulate
    const ssMlkem = ml_kem768.decapsulate(mlkemCiphertext, mlkemSecretKey)

    // Hybrid HKDF -> AES-KW key
    const unwrappingKey = await deriveHybridWrappingKey(ssEcdh, ssMlkem, ephPubRaw, mlkemCiphertext, 'unwrapKey')
    return await crypto.subtle.unwrapKey(
      'raw',
      wrappedCKBytes,
      unwrappingKey,
      'AES-KW',
      { name: aesAlgorithm, length: aesKeyLength },
      extractable,
      extractable ? ['encrypt', 'decrypt'] : ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    )
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw err
    }
    throw new DecryptionError('Failed to unwrap content key', { cause: err })
  }
}

// =============================================================================
// AES-GCM encrypt / decrypt
// =============================================================================

type EncryptedData = {
  iv: string // base64
  ciphertext: string // base64
}

/** Encrypt plaintext with CK using AES-256-GCM. Returns base64-encoded IV and ciphertext. */
export const encrypt = async (plaintext: string, ck: CryptoKey): Promise<EncryptedData> => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const encoded = new TextEncoder().encode(plaintext)
    const ciphertext = await crypto.subtle.encrypt({ name: aesAlgorithm, iv }, ck, encoded)
    return {
      iv: uint8ArrayToBase64(iv),
      ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    }
  } catch (err) {
    throw new EncryptionError('Failed to encrypt data', { cause: err })
  }
}

/** Decrypt ciphertext with CK using AES-256-GCM. Returns plaintext string. */
export const decrypt = async (data: EncryptedData, ck: CryptoKey): Promise<string> => {
  try {
    const iv = base64ToUint8Array(data.iv)
    const ciphertext = base64ToUint8Array(data.ciphertext)
    const decrypted = await crypto.subtle.decrypt({ name: aesAlgorithm, iv }, ck, ciphertext)
    return new TextDecoder().decode(decrypted)
  } catch (err) {
    throw new DecryptionError('Failed to decrypt data', { cause: err })
  }
}

// =============================================================================
// Base64 helpers
// =============================================================================

const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Array.from(atob(base64), (c) => c.charCodeAt(0)))
