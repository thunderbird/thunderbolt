import { ValidationError } from './errors'
import { fromHex, toHex } from './utils'

/** Derive a master key from a passphrase and salt using PBKDF2-SHA-256. */
export const deriveKeyFromPassphrase = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
  const passphraseBytes = new TextEncoder().encode(passphrase)

  const baseKey = await crypto.subtle.importKey('raw', passphraseBytes as BufferSource, 'PBKDF2', false, [
    'deriveBits',
    'deriveKey',
  ])

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 310_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
}

/** Generate a cryptographically random 128-bit salt. */
export const generateSalt = (): Uint8Array => crypto.getRandomValues(new Uint8Array(16))

/** Encode raw key bytes as a 64-character lowercase hex string. */
export const encodeRecoveryKey = (keyBytes: Uint8Array): string => toHex(keyBytes)

/**
 * Decode a 64-char hex string back to raw bytes.
 * Throws ValidationError if the input is not exactly 64 hex characters.
 */
export const decodeRecoveryKey = (hex: string): Uint8Array => {
  const normalized = hex.replace(/\s+/g, '').toLowerCase()
  if (normalized.length !== 64 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new ValidationError('Recovery key must be exactly 64 hexadecimal characters')
  }
  return fromHex(normalized)
}
