/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type SealedBindNonce, deviceBindHkdfInfo, ecdhKeyAlgorithm } from '@shared/e2ee-types'

/**
 * Server half of the device–session bind handshake (THU-873). The client half
 * (`openBindNonce`) lives in `src/crypto/device-bind.ts`; this module is the
 * only place allowed to SEAL, mirroring how `canary.ts` owns the server half of
 * the challenge protocol.
 *
 * The trust routes resolve their caller from `session.deviceId`, so a session
 * must prove it belongs to the device it claims. We seal a random nonce to the
 * device's stored ECDH public key: only the holder of the matching private key
 * can open it and echo the nonce back. Nothing here is a long-term secret — the
 * nonce is single-use and short-lived — which is why this is ECDH-only. Adding
 * ML-KEM would buy no post-quantum property worth having (there is no stored
 * ciphertext to harvest) and would exclude v1-era devices, which never
 * published an ML-KEM public key and would then be permanently unbindable.
 */

const aesGcmAlgorithm = 'AES-GCM'
const aesKeyLength = 256
const ivLength = 12
const hkdfHash = 'SHA-256'
const hkdfInfo = new TextEncoder().encode(deviceBindHkdfInfo)

/**
 * Derive the AES-GCM key that wraps a bind nonce. The ephemeral public key is
 * the HKDF salt, so the derivation is bound to this exchange and a key derived
 * for one handshake cannot decrypt another's ciphertext.
 */
const deriveSealingKey = async (
  ephemeralPrivateKey: CryptoKey,
  devicePublicKey: CryptoKey,
  ephemeralPublicKeyRaw: Uint8Array,
): Promise<CryptoKey> => {
  const shared = await crypto.subtle.deriveBits(
    { name: ecdhKeyAlgorithm.name, public: devicePublicKey },
    ephemeralPrivateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: hkdfHash, salt: ephemeralPublicKeyRaw as BufferSource, info: hkdfInfo },
    hkdfKey,
    { name: aesGcmAlgorithm, length: aesKeyLength },
    false,
    ['encrypt'],
  )
}

/**
 * Seal `nonce` to a device's `raw` base64 ECDH public key. Throws if the stored
 * public key is malformed or off-curve — `importKey` rejects it — so a device
 * row with unusable key material fails closed rather than yielding a blob no
 * one can open.
 */
export const sealBindNonce = async (devicePublicKeyBase64: string, nonce: string): Promise<SealedBindNonce> => {
  const devicePublicKey = await crypto.subtle.importKey(
    'raw',
    Buffer.from(devicePublicKeyBase64, 'base64'),
    ecdhKeyAlgorithm,
    false,
    [],
  )
  const ephemeral = await crypto.subtle.generateKey(ecdhKeyAlgorithm, false, ['deriveBits'])
  const ephemeralPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const sealingKey = await deriveSealingKey(ephemeral.privateKey, devicePublicKey, ephemeralPublicKeyRaw)

  const iv = crypto.getRandomValues(new Uint8Array(ivLength))
  const ciphertext = await crypto.subtle.encrypt(
    { name: aesGcmAlgorithm, iv },
    sealingKey,
    new TextEncoder().encode(nonce),
  )

  return {
    ephemeral_public_key: Buffer.from(ephemeralPublicKeyRaw).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(new Uint8Array(ciphertext)).toString('base64'),
  }
}
