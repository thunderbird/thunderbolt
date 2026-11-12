/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { encodeAAD, initialKeyId, payloadSeparator } from '@shared/e2ee-types'

import { base64ToUint8Array, decrypt, encrypt, uint8ArrayToBase64 } from './primitives'

/**
 * What one kind of continuity seal binds. Every field is a wire contract: the
 * recovery seal and the passkey seal differ in all of them, so neither can be
 * replayed as the other. `binding` adds values the MAC covers after the user id,
 * such as the passkey's credential id; it is empty for the recovery seal.
 */
export type ContinuitySealScope = { domain: string; aadColumn: string; plaintext: string; binding: readonly string[] }

const sampleAAD = (userId: string, scope: ContinuitySealScope): Uint8Array =>
  encodeAAD('__meta', scope.aadColumn, userId, initialKeyId)

const macPayload = (userId: string, scope: ContinuitySealScope, iv: string, ciphertext: string): Uint8Array =>
  new TextEncoder().encode([scope.domain, userId, ...scope.binding, iv, ciphertext].join(payloadSeparator))

/**
 * Derive a seal's HMAC-SHA256 key from a virtual device's HKDF master key (the
 * stretched recovery phrase, or a passkey's PRF output).
 */
export const deriveContinuityKey = (masterKey: CryptoKey, info: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: info as BufferSource },
    masterKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )

/**
 * Bind DEK `"0"` to a virtual device: a fixed-plaintext sample under DEK `"0"`,
 * MACed with the device's continuity key, as `iv:ciphertext:mac`.
 *
 * Anyone can wrap an Account Key to a virtual device's stored PUBLIC keys, so the
 * AK it opens proves nothing. Making the sample needs DEK `"0"` and MACing it
 * needs the virtual device's secret, so a server holding neither cannot pass off
 * a key set of its own. The MAC sits over the sample rather than inside it, so
 * holders of DEK `"0"`, revoked devices included, learn nothing about the key.
 */
export const sealContinuity = async (
  dek0: CryptoKey,
  macKey: CryptoKey,
  userId: string,
  scope: ContinuitySealScope,
): Promise<string> => {
  const { iv, ciphertext } = await encrypt(scope.plaintext, dek0, sampleAAD(userId, scope))
  const mac = await crypto.subtle.sign('HMAC', macKey, macPayload(userId, scope, iv, ciphertext) as BufferSource)
  return [iv, ciphertext, uint8ArrayToBase64(new Uint8Array(mac))].join(':')
}

/**
 * Does the served seal hold for this candidate DEK `"0"`? Fails closed: a
 * missing, malformed, foreign or forged seal all return false.
 */
export const continuityHolds = async (
  sealed: string | null | undefined,
  dek0: CryptoKey,
  macKey: CryptoKey,
  userId: string,
  scope: ContinuitySealScope,
): Promise<boolean> => {
  const [iv, ciphertext, mac, ...extra] = sealed?.split(':') ?? []
  if (!iv || !ciphertext || !mac || extra.length > 0) {
    return false
  }
  try {
    const authentic = await crypto.subtle.verify(
      'HMAC',
      macKey,
      base64ToUint8Array(mac) as BufferSource,
      macPayload(userId, scope, iv, ciphertext) as BufferSource,
    )
    return authentic && (await decrypt({ iv, ciphertext }, dek0, sampleAAD(userId, scope))) === scope.plaintext
  } catch {
    // Served bytes that do not decode, or a sample DEK "0" cannot open, are unverified.
    return false
  }
}
