/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { base64ToUint8Array } from './primitives'

/** The first bytes of every `kdf_salt` whose phrase was minted with a continuity seal. */
export const continuitySaltTag = new TextEncoder().encode('tb-rc-v1')

/**
 * Does recovery under this salt require a valid continuity seal? False only for
 * phrases minted before the seal existed, whose salts are fully random.
 *
 * Kept apart from `recovery-key.ts` so UI code can read the tag without loading
 * the recovery derivation's dependencies.
 */
export const kdfSaltRequiresContinuity = (saltBase64: string): boolean => {
  const salt = base64ToUint8Array(saltBase64)
  return continuitySaltTag.every((byte, index) => salt[index] === byte)
}
