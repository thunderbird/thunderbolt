/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { encPrefix, encV2Prefix, wireVersionV2, type KeyId } from '@shared/e2ee-types'

export { encPrefix, encV2Prefix, wireVersionV2 }

/** Parsed v2 wire value: __enc:v2:<key_id>:<iv-base64>:<ct-base64>. */
export type ParsedWireValue = {
  version: typeof wireVersionV2
  keyId: KeyId
  /** Base64 12-byte IV. */
  iv: string
  /** Base64 AES-256-GCM ciphertext (includes the auth tag). */
  ciphertext: string
}

/** Whether a stored value carries the encryption sentinel (v1 or v2). Detection only. */
export const isEncryptedValue = (value: string): boolean => value.startsWith(encPrefix)

/** Whether a stored value is in the v2 wire format. */
export const isV2EncryptedValue = (value: string): boolean => value.startsWith(encV2Prefix)

/**
 * Parse a v2 wire value. Returns null for anything that is not a well-formed
 * five-segment v2 value (including every v1 `__enc:<iv>:<ct>` value — a v1 IV
 * is 16 base64 chars so its second segment can never equal `v2`).
 */
export const parseWireValue = (value: string): ParsedWireValue | null => {
  if (!value.startsWith(encV2Prefix)) {
    return null
  }
  const rest = value.slice(encV2Prefix.length)
  const firstSep = rest.indexOf(':')
  const secondSep = firstSep === -1 ? -1 : rest.indexOf(':', firstSep + 1)
  if (firstSep <= 0 || secondSep === -1) {
    return null
  }
  const keyId = rest.slice(0, firstSep)
  const iv = rest.slice(firstSep + 1, secondSep)
  const ciphertext = rest.slice(secondSep + 1)
  if (!iv || !ciphertext || ciphertext.includes(':')) {
    return null
  }
  return { version: wireVersionV2, keyId, iv, ciphertext }
}

/** Assemble a v2 wire value from its segments. */
export const formatWireValue = (keyId: KeyId, iv: string, ciphertext: string): string =>
  `${encV2Prefix}${keyId}:${iv}:${ciphertext}`
