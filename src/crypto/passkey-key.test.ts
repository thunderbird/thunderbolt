/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { derivePasskeyKeyPair } from './passkey-key'
import { exportMlKemPublicKey, exportPublicKey, generateAK, unwrapAK, wrapAK } from './primitives'

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')

const randomPrfOutput = () => crypto.getRandomValues(new Uint8Array(32))

describe('derivePasskeyKeyPair', () => {
  it('produces a StoredKeyPair-shaped hybrid keypair', async () => {
    const kp = await derivePasskeyKeyPair(randomPrfOutput())
    expect(kp.ecdhPrivateKey.extractable).toBe(false)
    expect([...kp.ecdhPrivateKey.usages]).toEqual(['deriveBits'])
    expect(kp.mlkemPublicKey.length).toBe(1184)
    expect(kp.mlkemSecretKey.length).toBe(2400)
  })

  it('derives byte-identical public keys from the same PRF output', async () => {
    const prf = randomPrfOutput()
    const first = await derivePasskeyKeyPair(prf)
    const second = await derivePasskeyKeyPair(prf)
    expect(await exportPublicKey(second.ecdhPublicKey)).toBe(await exportPublicKey(first.ecdhPublicKey))
    expect(exportMlKemPublicKey(second.mlkemPublicKey)).toBe(exportMlKemPublicKey(first.mlkemPublicKey))
  })

  it('derives a different keypair for a different passkey', async () => {
    const first = await derivePasskeyKeyPair(randomPrfOutput())
    const second = await derivePasskeyKeyPair(randomPrfOutput())
    expect(await exportPublicKey(second.ecdhPublicKey)).not.toBe(await exportPublicKey(first.ecdhPublicKey))
  })

  // The HKDF labels are a wire contract: a change would strand every enrolled slot.
  it('matches the frozen known-answer vector', async () => {
    const kp = await derivePasskeyKeyPair(new Uint8Array(32).map((_, i) => i))
    expect(await exportPublicKey(kp.ecdhPublicKey)).toBe(
      'BHMjjrP0AoKrGAJDP4KlIULXXUIfK2KxfurxoR17BNPxDPliZnN90mVH0coj1Awx6q8GMPsvtw1yMU2H04Mog5M=',
    )
    expect(await sha256Hex(kp.mlkemPublicKey)).toBe('48932e662910c468b7a007bdf5d3a06078df088efc0327c5236c890ae16b497d')
  })

  it('opens an AK wrapped to its public keys', async () => {
    const prf = randomPrfOutput()
    const kp = await derivePasskeyKeyPair(prf)
    const ak = await generateAK(true)
    const wrapped = await wrapAK(ak, kp.ecdhPublicKey, kp.mlkemPublicKey, '0')

    const reDerived = await derivePasskeyKeyPair(prf)
    const { ak: opened } = await unwrapAK(wrapped, reDerived.ecdhPrivateKey, reDerived.mlkemSecretKey)
    expect(opened).toBeDefined()
  })
})
