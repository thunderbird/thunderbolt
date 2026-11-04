/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { KeyDerivationError } from './errors'
import type { StoredKeyPair } from './key-storage'
import { deriveHybridKeyPair } from './recovery-key'

// Wire contracts, like the recovery labels: changing any of them re-derives a
// different keypair and strands every enrolled passkey slot.
const ecdhHkdfInfo = new TextEncoder().encode('thunderbolt-passkey-ecdh-v1')
const mlkemHkdfInfo = new TextEncoder().encode('thunderbolt-passkey-mlkem-v1')

/**
 * Deterministically derive the passkey slot's hybrid keypair from the passkey's
 * 32-byte PRF output — the passkey is a virtual device, like the recovery phrase.
 *
 * prfOutput --HKDF-SHA256, info='…-ecdh-v1'--> P-256 scalar
 *           --HKDF-SHA256, info='…-mlkem-v1'-> ML-KEM-768 seed
 *
 * No PBKDF2 stretch: the PRF output is already a uniformly random secret, not
 * something a person typed.
 */
export const derivePasskeyKeyPair = async (prfOutput: Uint8Array): Promise<StoredKeyPair> => {
  try {
    const masterKey = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, ['deriveBits'])
    return await deriveHybridKeyPair(masterKey, { ecdh: ecdhHkdfInfo, mlkem: mlkemHkdfInfo })
  } catch (err) {
    throw new KeyDerivationError('Failed to derive passkey keypair from PRF output', { cause: err })
  }
}
