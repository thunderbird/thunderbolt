/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { encodeAAD, initialKeyId } from '@shared/e2ee-types'

import { DecryptionError } from './errors'
import { decrypt, encrypt } from './primitives'

/**
 * DURABLE ON-DISK FORMAT VERSION. Bump when `anchorPlaintext`, the AAD tuple, or
 * `encodeAAD`'s own encoding changes — a colocated snapshot test fails on any
 * content drift without a matching bump.
 *
 * Why this has to exist: a stored anchor whose format no longer matches what the
 * verifier builds cannot be *distinguished* from an anchor a substituted key
 * fails to open. Without the version, a well-meaning consistency sweep over the
 * `__meta` AAD family (THU-872 may do exactly that) would make every device on
 * every account refuse every future Account Key, silently and permanently. With
 * it, a drifted anchor is recognized as stale and re-minted from local state.
 */
export const anchorVersion = 1

/** Fixed, non-secret plaintext. Carries no entropy — the DEK does all the work. */
const anchorPlaintext = 'thunderbolt-keyring-anchor'

/**
 * The anchor is bound to DEK `"0"` and to its own format version. Deliberately
 * NOT bound to `userId`: `getUserId` reads the cached session out of
 * localStorage and throws when it is absent, and the 401 path clears that cache
 * while explicitly preserving encryption keys — so binding it would make Account
 * Key adoption fail in a window the app creates on purpose. It also buys
 * nothing, since DEK `"0"` is already account-scoped: a foreign anchor cannot
 * open under another account's DEK `"0"` whether `userId` is bound in or not.
 */
const keyringAnchorAAD = (): Uint8Array => encodeAAD('__meta', 'keyring_anchor', String(anchorVersion), initialKeyId)

/**
 * A device-local witness to DEK `"0"`'s key material, written once and never
 * rewritten.
 *
 * It exists because the AK envelope is ANONYMOUS — `wrapAK` needs only a
 * device's public keys, which the server stores — so a malicious server can mint
 * an AK of its own and serve it in a well-formed envelope. Nothing else on the
 * client can tell the difference: the canary, `signing_public_key` and the
 * keyring are all server-supplied (THU-869).
 */
export type KeyringAnchor = {
  version: number
  iv: string
  ciphertext: string
}

/**
 * Mint the anchor from DEK `"0"`.
 *
 * MUST be called with a DEK `"0"` derived from LOCAL state (the stored AK
 * unwrapping the locally staged blob) and never with one derived from a
 * candidate AK. Minting from server-supplied material hands the adversary the
 * check's own bypass: omit `key_id "0"` from the keyring response and no device
 * ever mints one, leaving `getKeyringAnchor() == null` — the skip condition —
 * true forever.
 *
 * Fixed plaintext with a RANDOM IV (`encrypt` generates one). A fixed IV would
 * be GCM nonce reuse under a DEK that also encrypts live rows.
 */
export const mintKeyringAnchor = async (dek0: CryptoKey): Promise<KeyringAnchor> => {
  const { iv, ciphertext } = await encrypt(anchorPlaintext, dek0, keyringAnchorAAD())
  return { version: anchorVersion, iv, ciphertext }
}

/**
 * Does `dek0` hold the same key material the anchor was minted under?
 *
 * A `false` is not a diagnosis. Called with a DEK `"0"` unwrapped under a
 * CANDIDATE AK it means either the candidate is not this account's Account Key
 * or DEK `"0"`'s material changed — indistinguishable from here, which is why
 * the caller reports the symptom rather than a cause.
 *
 * A stale on-disk FORMAT is distinguishable, and is the one case a caller may
 * act on by re-minting: it shows up as a version mismatch rather than as a
 * failed decrypt. Note that "does not open" alone must never trigger a re-mint —
 * AES-KW carries no key_id binding, so a server can serve an honest blob for a
 * different key under `key_id "0"`, and re-minting on disagreement would let it
 * repoint the witness at a key it chose.
 *
 * Returns `false` rather than throwing on a wrong key: an authentication-tag
 * failure is the expected negative result here, not an exception. Mirrors
 * `verifyCanary`.
 */
export const keyringAnchorOpens = async (anchor: KeyringAnchor, dek0: CryptoKey): Promise<boolean> => {
  if (anchor.version !== anchorVersion) {
    return false
  }
  try {
    const plaintext = await decrypt({ iv: anchor.iv, ciphertext: anchor.ciphertext }, dek0, keyringAnchorAAD())
    return plaintext === anchorPlaintext
  } catch (err) {
    if (err instanceof DecryptionError) {
      return false
    }
    throw err
  }
}
