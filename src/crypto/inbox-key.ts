/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { inboxSeedLength } from '@shared/e2ee-types'
import { DecryptionError, EncryptionError, KeyDerivationError } from './errors'
import type { StoredKeyPair } from './key-storage'
import {
  aesGcmAlgorithm,
  base64ToUint8Array,
  exportMlKemPublicKey,
  exportPublicKey,
  ivLength,
  uint8ArrayToBase64,
} from './primitives'
import { deriveHybridKeyPair } from './hybrid-keypair'

// Wire contracts: changing either re-derives a different keypair from every
// stored seed and strands every share sealed to the old one.
const ecdhHkdfInfo = new TextEncoder().encode('thunderbolt-inbox-ecdh-v1')
const mlkemHkdfInfo = new TextEncoder().encode('thunderbolt-inbox-mlkem-v1')

/** The public half of an inbox keypair, base64 as served by the directory. */
export type InboxPublicKeys = { ecdhPublicKey: string; mlkemPublicKey: string }

/** A fresh random inbox seed. */
export const generateInboxSeed = (): Uint8Array => crypto.getRandomValues(new Uint8Array(inboxSeedLength))

/**
 * Derive the inbox keypair from its seed. Deterministic, so every device that
 * can open the seed arrives at the same keypair with nothing to sync.
 */
export const deriveInboxKeyPair = async (seed: Uint8Array): Promise<StoredKeyPair> => {
  try {
    const masterKey = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, ['deriveBits'])
    return await deriveHybridKeyPair(masterKey, { ecdh: ecdhHkdfInfo, mlkem: mlkemHkdfInfo })
  } catch (err) {
    throw new KeyDerivationError('Failed to derive inbox keypair', { cause: err })
  }
}

/** Export the public half of an inbox keypair for publishing. */
export const exportInboxPublicKeys = async (keyPair: StoredKeyPair): Promise<InboxPublicKeys> => ({
  ecdhPublicKey: await exportPublicKey(keyPair.ecdhPublicKey),
  mlkemPublicKey: exportMlKemPublicKey(keyPair.mlkemPublicKey),
})

/** Encrypt an inbox seed under a DEK. Returns base64 `iv ‖ ciphertext`; `aad` is `inboxSeedAAD`. */
export const encryptInboxSeed = async (seed: Uint8Array, dek: CryptoKey, aad: Uint8Array): Promise<string> => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: aesGcmAlgorithm, iv: iv as BufferSource, additionalData: aad as BufferSource },
        dek,
        seed as BufferSource,
      ),
    )
    const blob = new Uint8Array(iv.length + ciphertext.length)
    blob.set(iv, 0)
    blob.set(ciphertext, iv.length)
    return uint8ArrayToBase64(blob)
  } catch (err) {
    throw new EncryptionError('Failed to encrypt inbox seed', { cause: err })
  }
}

/** Decrypt an inbox seed sealed by `encryptInboxSeed`. */
export const decryptInboxSeed = async (encryptedSeed: string, dek: CryptoKey, aad: Uint8Array): Promise<Uint8Array> => {
  try {
    const blob = base64ToUint8Array(encryptedSeed)
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: aesGcmAlgorithm, iv: blob.slice(0, ivLength) as BufferSource, additionalData: aad as BufferSource },
        dek,
        blob.slice(ivLength) as BufferSource,
      ),
    )
  } catch (err) {
    throw new DecryptionError('Failed to decrypt inbox seed', { cause: err })
  }
}

/**
 * Open an inbox key version: decrypt its seed, derive the keypair, and require
 * it to match the published public keys. A mismatch means the row was planted
 * or corrupted — shares sealed to those public keys were not sealed to us, so
 * nothing is opened with it.
 */
export const openInboxKeyPair = async (
  row: InboxPublicKeys & { encryptedSeed: string },
  dek: CryptoKey,
  aad: Uint8Array,
): Promise<StoredKeyPair> => {
  const seed = await decryptInboxSeed(row.encryptedSeed, dek, aad)
  try {
    const keyPair = await deriveInboxKeyPair(seed)
    const derived = await exportInboxPublicKeys(keyPair)
    if (derived.ecdhPublicKey !== row.ecdhPublicKey || derived.mlkemPublicKey !== row.mlkemPublicKey) {
      throw new DecryptionError('Inbox key does not match its published public keys')
    }
    return keyPair
  } finally {
    seed.fill(0)
  }
}
