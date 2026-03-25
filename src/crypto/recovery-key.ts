import { ValidationError } from './errors'

/**
 * Encode an extractable CK as a 64-character hex string (recovery key).
 * CK must be extractable — this is only valid during first device setup.
 */
export const encodeRecoveryKey = async (ck: CryptoKey): Promise<string> => {
  const raw = await crypto.subtle.exportKey('raw', ck)
  return Array.from(new Uint8Array(raw))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Decode a 64-character hex recovery key into an extractable AES-256-GCM CryptoKey.
 * Extractable because the recovery flow needs to wrap it for the device's envelope.
 * Caller must reimport as non-extractable before storing in IndexedDB.
 */
export const decodeRecoveryKey = async (hex: string): Promise<CryptoKey> => {
  const cleaned = hex.replace(/\s/g, '')

  if (cleaned.length !== 64) {
    throw new ValidationError('Recovery key must be 64 hex characters (32 bytes).')
  }
  if (!/^[0-9a-f]+$/i.test(cleaned)) {
    throw new ValidationError('Recovery key must contain only hex characters (0-9, a-f).')
  }

  const bytes = new Uint8Array(cleaned.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)))

  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
    'wrapKey',
    'unwrapKey',
  ])
}
