import { DecryptionError, EncryptionError } from './errors'

const rsaAlgorithm = 'RSA-OAEP'
const rsaModulusLength = 2048
const rsaHash = 'SHA-256'
const aesAlgorithm = 'AES-GCM'
const aesKeyLength = 256
const ivLength = 12

// =============================================================================
// RSA key pair (for wrapping/unwrapping CK)
// =============================================================================

/** Generate an RSA-OAEP 2048-bit key pair for wrapping/unwrapping CK. */
export const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(
    { name: rsaAlgorithm, modulusLength: rsaModulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: rsaHash },
    false, // non-extractable
    ['wrapKey', 'unwrapKey'],
  )

/** Export a public key to base64 (for sending to the server). */
export const exportPublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const exported = await crypto.subtle.exportKey('spki', publicKey)
  return uint8ArrayToBase64(new Uint8Array(exported))
}

/** Import a public key from base64 (for wrapping CK with another device's key). */
export const importPublicKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('spki', base64ToUint8Array(base64), { name: rsaAlgorithm, hash: rsaHash }, false, ['wrapKey'])

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
// Wrap / Unwrap CK with RSA
// =============================================================================

/** Wrap CK with a device's public key. Returns base64. */
export const wrapCK = async (ck: CryptoKey, publicKey: CryptoKey): Promise<string> => {
  try {
    const wrapped = await crypto.subtle.wrapKey('raw', ck, publicKey, { name: rsaAlgorithm })
    return uint8ArrayToBase64(new Uint8Array(wrapped))
  } catch (err) {
    throw new EncryptionError('Failed to wrap content key', { cause: err })
  }
}

/**
 * Rewrap a wrapped CK for a different device's public key.
 * Internally unwraps as temporarily extractable (in-memory only, never stored),
 * then wraps with the target public key. Returns base64.
 */
export const rewrapCK = async (
  wrappedCKBase64: string,
  privateKey: CryptoKey,
  targetPublicKey: CryptoKey,
): Promise<string> => {
  try {
    const tempCK = await crypto.subtle.unwrapKey(
      'raw',
      base64ToUint8Array(wrappedCKBase64),
      privateKey,
      { name: rsaAlgorithm },
      { name: aesAlgorithm, length: aesKeyLength },
      true,
      ['encrypt', 'decrypt'],
    )
    const wrapped = await crypto.subtle.wrapKey('raw', tempCK, targetPublicKey, { name: rsaAlgorithm })
    return uint8ArrayToBase64(new Uint8Array(wrapped))
  } catch (err) {
    throw new EncryptionError('Failed to rewrap content key', { cause: err })
  }
}

/** Unwrap CK from base64 using a device's private key. Returns non-extractable CryptoKey. */
export const unwrapCK = async (wrappedBase64: string, privateKey: CryptoKey): Promise<CryptoKey> => {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      base64ToUint8Array(wrappedBase64),
      privateKey,
      { name: rsaAlgorithm },
      { name: aesAlgorithm, length: aesKeyLength },
      false, // non-extractable
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    )
  } catch (err) {
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
