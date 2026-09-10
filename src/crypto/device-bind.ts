/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type SealedBindNonce, deviceBindHkdfInfo, ecdhKeyAlgorithm } from '@shared/e2ee-types'
import { base64ToUint8Array } from './primitives'

/**
 * Client half of the device–session bind handshake (THU-873) — the server half
 * (`sealBindNonce`) lives in `backend/src/lib/device-bind.ts`. Only the device
 * holding this ECDH private key can recover the nonce the server sealed to its
 * public half, which is what lets the backend bind the session to this device
 * and then resolve every trust route's caller from `session.deviceId` instead
 * of the client-set `X-Device-ID` header.
 *
 * The private key is a non-extractable `deriveBits` CryptoKey from IndexedDB
 * (`getKeyPair`), so opening a challenge never exposes key material.
 */

const aesGcmAlgorithm = 'AES-GCM'
const aesKeyLength = 256
const hkdfHash = 'SHA-256'
const hkdfInfo = new TextEncoder().encode(deviceBindHkdfInfo)

/**
 * Open a sealed bind nonce with this device's ECDH private key.
 * Throws on a tampered or foreign-sealed blob — AES-GCM authentication fails,
 * and a malformed ephemeral key is rejected by `importKey`.
 */
export const openBindNonce = async (ecdhPrivateKey: CryptoKey, sealed: SealedBindNonce): Promise<string> => {
  const ephemeralPublicKeyRaw = base64ToUint8Array(sealed.ephemeral_public_key)
  const ephemeralPublicKey = await crypto.subtle.importKey('raw', ephemeralPublicKeyRaw, ecdhKeyAlgorithm, false, [])

  const shared = await crypto.subtle.deriveBits(
    { name: ecdhKeyAlgorithm.name, public: ephemeralPublicKey },
    ecdhPrivateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const sealingKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: hkdfHash, salt: ephemeralPublicKeyRaw as BufferSource, info: hkdfInfo },
    hkdfKey,
    { name: aesGcmAlgorithm, length: aesKeyLength },
    false,
    ['decrypt'],
  )

  const plaintext = await crypto.subtle.decrypt(
    { name: aesGcmAlgorithm, iv: base64ToUint8Array(sealed.iv) },
    sealingKey,
    base64ToUint8Array(sealed.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
