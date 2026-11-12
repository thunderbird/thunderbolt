/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { continuityHolds, deriveContinuityKey, sealContinuity, type ContinuitySealScope } from './continuity-seal'
import { KeyDerivationError } from './errors'
import type { StoredKeyPair } from './key-storage'
import { deriveHybridKeyPair } from './recovery-key'

// Wire contracts, like the recovery labels: changing any of them re-derives a
// different keypair and strands every enrolled passkey slot.
const ecdhHkdfInfo = new TextEncoder().encode('thunderbolt-passkey-ecdh-v1')
const mlkemHkdfInfo = new TextEncoder().encode('thunderbolt-passkey-mlkem-v1')

// Labels for the sealed slot format. They derive public keys that a legacy slot
// for the same passkey never has, so the client tells the two formats apart
// without trusting a server field.
const sealedEcdhHkdfInfo = new TextEncoder().encode('thunderbolt-passkey-ecdh-v2')
const sealedMlkemHkdfInfo = new TextEncoder().encode('thunderbolt-passkey-mlkem-v2')
const continuityHkdfInfo = new TextEncoder().encode('thunderbolt-passkey-continuity-key-v2')

const passkeyContinuityScope = (credentialId: string): ContinuitySealScope => ({
  domain: 'thunderbolt-passkey-continuity-v2',
  aadColumn: 'passkey_continuity',
  plaintext: 'thunderbolt-passkey-continuity',
  binding: [credentialId],
})

/** A sealed slot's keypair plus its continuity key (HMAC-SHA256, sign/verify only). */
export type SealedPasskeyKeyPair = StoredKeyPair & { continuityKey: CryptoKey }

const importPrfMasterKey = (prfOutput: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey'])

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
    return await deriveHybridKeyPair(await importPrfMasterKey(prfOutput), { ecdh: ecdhHkdfInfo, mlkem: mlkemHkdfInfo })
  } catch (err) {
    throw new KeyDerivationError('Failed to derive passkey keypair from PRF output', { cause: err })
  }
}

/**
 * Derive the SEALED slot's keypair and continuity key from the same PRF output,
 * under the v2 labels. New and migrated slots use this format.
 */
export const deriveSealedPasskeyKeyPair = async (prfOutput: Uint8Array): Promise<SealedPasskeyKeyPair> => {
  try {
    const masterKey = await importPrfMasterKey(prfOutput)
    const continuityKey = await deriveContinuityKey(masterKey, continuityHkdfInfo)
    return {
      ...(await deriveHybridKeyPair(masterKey, { ecdh: sealedEcdhHkdfInfo, mlkem: sealedMlkemHkdfInfo })),
      continuityKey,
    }
  } catch (err) {
    throw new KeyDerivationError('Failed to derive sealed passkey keypair from PRF output', { cause: err })
  }
}

/** Seal DEK `"0"` to a passkey, bound to its credential id (`passkey_continuity`). */
export const sealPasskeyContinuity = (
  dek0: CryptoKey,
  continuityKey: CryptoKey,
  userId: string,
  credentialId: string,
): Promise<string> => sealContinuity(dek0, continuityKey, userId, passkeyContinuityScope(credentialId))

/** Does the served passkey seal hold for this candidate DEK `"0"`? Fails closed. */
export const passkeyContinuityHolds = (
  sealed: string | null | undefined,
  dek0: CryptoKey,
  continuityKey: CryptoKey,
  userId: string,
  credentialId: string,
): Promise<boolean> => continuityHolds(sealed, dek0, continuityKey, userId, passkeyContinuityScope(credentialId))
