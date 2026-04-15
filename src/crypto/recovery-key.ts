import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

import { ValidationError } from './errors'

/**
 * Encode an extractable CK as a 24-word BIP-39 mnemonic (recovery phrase).
 * CK must be extractable — this is only valid during first device setup.
 */
export const encodeRecoveryKey = async (ck: CryptoKey): Promise<string> => {
  const raw = await crypto.subtle.exportKey('raw', ck)
  return entropyToMnemonic(new Uint8Array(raw), wordlist)
}

/**
 * Decode a 24-word BIP-39 mnemonic into an extractable AES-256-GCM CryptoKey.
 * Validates checksum per BIP-39 spec.
 * Extractable because the recovery flow needs to wrap it for the device's envelope.
 * Caller must reimport as non-extractable before storing in IndexedDB.
 */
export const decodeRecoveryKey = async (mnemonic: string): Promise<CryptoKey> => {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')

  let bytes: Uint8Array
  try {
    bytes = mnemonicToEntropy(normalized, wordlist)
  } catch {
    throw new ValidationError(
      'Invalid recovery phrase. Please check that all 24 words are correct and in the right order.',
    )
  }

  if (bytes.length !== 32) {
    throw new ValidationError('Recovery phrase must be exactly 24 words (256-bit key).')
  }

  return crypto.subtle.importKey(
    'raw',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
}
