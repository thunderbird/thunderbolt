/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { deviceBindHkdfInfo, ecdhKeyAlgorithm } from '@shared/e2ee-types'
import type { SealedBindNonce } from '@shared/e2ee-types'
import { sealBindNonce } from './device-bind'

/** Stand-in for the nonce `issueChallengeNonce` mints and stores server-side. */
const aNonce = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

/**
 * The seal half lives here; the open half ships in the frontend
 * (`src/crypto/device-bind.ts`). This test reimplements ONLY the open side, so
 * a divergence in the derivation — algorithm, salt, or info string — fails
 * here rather than silently breaking every device's ability to bind.
 */
const openBindNonce = async (ecdhPrivateKey: CryptoKey, sealed: SealedBindNonce): Promise<string> => {
  const ephemeralPublicKeyRaw = new Uint8Array(Buffer.from(sealed.ephemeral_public_key, 'base64'))
  const ephemeralPublicKey = await crypto.subtle.importKey('raw', ephemeralPublicKeyRaw, ecdhKeyAlgorithm, false, [])
  const shared = await crypto.subtle.deriveBits(
    { name: ecdhKeyAlgorithm.name, public: ephemeralPublicKey },
    ecdhPrivateKey,
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
    ['decrypt'],
  )
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(Buffer.from(sealed.iv, 'base64')) },
    sealingKey,
    new Uint8Array(Buffer.from(sealed.ciphertext, 'base64')),
  )
  return new TextDecoder().decode(plaintext)
}

/** A device keypair as `registerDevice` would store it: base64 `raw` public half. */
const createDevice = async () => {
  const pair = await crypto.subtle.generateKey(ecdhKeyAlgorithm, false, ['deriveBits'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKeyBase64: Buffer.from(raw).toString('base64') }
}

describe('device bind nonce', () => {
  it('round-trips: the device that owns the public key recovers the nonce', async () => {
    const device = await createDevice()
    const nonce = aNonce()

    const sealed = await sealBindNonce(device.publicKeyBase64, nonce)

    expect(await openBindNonce(device.privateKey, sealed)).toBe(nonce)
  })

  it('never puts the nonce on the wire in the clear', async () => {
    const device = await createDevice()
    const nonce = aNonce()

    const sealed = await sealBindNonce(device.publicKeyBase64, nonce)

    expect(JSON.stringify(sealed)).not.toContain(nonce)
  })

  it('is opaque to a different device — this is the whole security property', async () => {
    const owner = await createDevice()
    const attacker = await createDevice()

    const sealed = await sealBindNonce(owner.publicKeyBase64, aNonce())

    await expect(openBindNonce(attacker.privateKey, sealed)).rejects.toThrow()
  })

  it('rejects a tampered ciphertext, iv, or ephemeral key (AES-GCM is authenticated)', async () => {
    const device = await createDevice()
    const sealed = await sealBindNonce(device.publicKeyBase64, aNonce())
    const other = await sealBindNonce(device.publicKeyBase64, aNonce())

    await expect(openBindNonce(device.privateKey, { ...sealed, ciphertext: other.ciphertext })).rejects.toThrow()
    await expect(openBindNonce(device.privateKey, { ...sealed, iv: other.iv })).rejects.toThrow()
    // A different ephemeral key derives a different sealing key AND a different
    // HKDF salt, so substituting one cannot re-open the original ciphertext.
    await expect(
      openBindNonce(device.privateKey, { ...sealed, ephemeral_public_key: other.ephemeral_public_key }),
    ).rejects.toThrow()
  })

  it('seals a fresh nonce and ephemeral key every time', async () => {
    const device = await createDevice()

    const first = await sealBindNonce(device.publicKeyBase64, aNonce())
    const second = await sealBindNonce(device.publicKeyBase64, aNonce())

    expect(first.ephemeral_public_key).not.toBe(second.ephemeral_public_key)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(aNonce()).not.toBe(aNonce())
  })

  it('fails closed on unusable stored key material rather than sealing to nothing', async () => {
    await expect(sealBindNonce('not-base64-key-material', aNonce())).rejects.toThrow()
  })
})
