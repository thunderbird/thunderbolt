/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { kdfAlgorithm, kdfHash, kdfIterations, kdfSaltLength } from '@shared/e2ee-types'

import { KeyDerivationError, ValidationError } from './errors'
import { base64ToUint8Array, uint8ArrayToBase64 } from './primitives'

const seedLength = 32 // bytes → 24 BIP-39 words

/** Generate a random 256-bit recovery seed (the value the 24 words encode). */
export const generateRecoverySeed = (): Uint8Array => crypto.getRandomValues(new Uint8Array(seedLength))

/** Encode a recovery seed as a 24-word BIP-39 mnemonic (recovery phrase). */
export const encodeRecoverySeed = (seed: Uint8Array): string => entropyToMnemonic(seed, wordlist)

/**
 * Decode a 24-word BIP-39 mnemonic into the recovery seed (checksum-validated).
 * Seed only — deriving the AK is a separate `deriveAKFromSeed` call that needs
 * the server-stored `kdf_salt`.
 */
export const decodeRecoveryKey = (mnemonic: string): Uint8Array => {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')

  let bytes: Uint8Array
  try {
    bytes = mnemonicToEntropy(normalized, wordlist)
  } catch {
    throw new ValidationError(
      'Invalid recovery phrase. Please check that all 24 words are correct and in the right order.',
    )
  }

  if (bytes.length !== seedLength) {
    throw new ValidationError('Recovery phrase must be exactly 24 words (256-bit key).')
  }

  return bytes
}

/**
 * Derive the AK from the recovery seed via PBKDF2-SHA512 600k (THU-414).
 * Non-extractable by default; pass `extractable: true` only during setup —
 * wrapping the AK into device envelopes requires it extractable.
 */
export const deriveAKFromSeed = async (
  seed: Uint8Array,
  saltBase64: string,
  opts?: { extractable?: boolean },
): Promise<CryptoKey> => {
  try {
    const baseKey = await crypto.subtle.importKey('raw', seed as BufferSource, kdfAlgorithm, false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      {
        name: kdfAlgorithm,
        hash: kdfHash,
        salt: base64ToUint8Array(saltBase64),
        iterations: kdfIterations,
      },
      baseKey,
      { name: 'AES-KW', length: 256 },
      opts?.extractable ?? false,
      ['wrapKey', 'unwrapKey'],
    )
  } catch (err) {
    throw new KeyDerivationError('Failed to derive account key from recovery seed', { cause: err })
  }
}

/** Generate a random per-account KDF salt, base64-encoded (stored server-side as `kdf_salt`). */
export const generateKdfSalt = (): string => uint8ArrayToBase64(crypto.getRandomValues(new Uint8Array(kdfSaltLength)))
