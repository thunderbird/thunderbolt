/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { type SealedBindNonce, deviceBindHkdfInfo, ecdhKeyAlgorithm } from '@shared/e2ee-types'
import { openBindNonce } from './device-bind'
import { generateKeyPair, uint8ArrayToBase64 } from './primitives'

/**
 * Mirror of the SERVER seal (`backend/src/lib/device-bind.ts`), which the
 * frontend must never perform for real. Reimplementing it here means a
 * divergence in the derivation fails in this file instead of leaving every
 * device unable to bind its session.
 */
const sealBindNonce = async (devicePublicKey: CryptoKey, nonce: string): Promise<SealedBindNonce> => {
  const ephemeral = await crypto.subtle.generateKey(ecdhKeyAlgorithm, false, ['deriveBits'])
  const ephemeralPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const shared = await crypto.subtle.deriveBits(
    { name: ecdhKeyAlgorithm.name, public: devicePublicKey },
    ephemeral.privateKey,
    256,
  )
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const sealingKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemeralPublicKeyRaw as BufferSource,
      info: new TextEncoder().encode(deviceBindHkdfInfo),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sealingKey, new TextEncoder().encode(nonce))
  return {
    ephemeral_public_key: uint8ArrayToBase64(ephemeralPublicKeyRaw),
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
  }
}

describe('openBindNonce', () => {
  it('recovers a nonce sealed to this device with the stored ECDH keypair', async () => {
    // The same keypair shape the device registers with — non-extractable,
    // `deriveBits` only. Proves the stored key needs no new usage flag.
    const keyPair = await generateKeyPair()
    const nonce = 'bind-nonce-under-test'

    const sealed = await sealBindNonce(keyPair.publicKey, nonce)

    expect(await openBindNonce(keyPair.privateKey, sealed)).toBe(nonce)
  })

  it('refuses a challenge sealed to a different device', async () => {
    const owner = await generateKeyPair()
    const attacker = await generateKeyPair()

    const sealed = await sealBindNonce(owner.publicKey, 'not-for-you')

    await expect(openBindNonce(attacker.privateKey, sealed)).rejects.toThrow()
  })

  it('refuses a tampered blob', async () => {
    const keyPair = await generateKeyPair()
    const sealed = await sealBindNonce(keyPair.publicKey, 'original')
    const decoy = await sealBindNonce(keyPair.publicKey, 'decoy')

    await expect(openBindNonce(keyPair.privateKey, { ...sealed, ciphertext: decoy.ciphertext })).rejects.toThrow()
    await expect(openBindNonce(keyPair.privateKey, { ...sealed, iv: decoy.iv })).rejects.toThrow()
    await expect(
      openBindNonce(keyPair.privateKey, { ...sealed, ephemeral_public_key: decoy.ephemeral_public_key }),
    ).rejects.toThrow()
  })
})
