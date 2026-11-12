/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import {
  derivePasskeyKeyPair,
  deriveSealedPasskeyKeyPair,
  passkeyContinuityHolds,
  sealPasskeyContinuity,
} from './passkey-key'
import { exportMlKemPublicKey, exportPublicKey, generateAK, generateDEK, unwrapAK, wrapAK } from './primitives'
import { sealRecoveryContinuity } from './recovery-key'

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
    const wrapped = await wrapAK(ak, kp.ecdhPublicKey, kp.mlkemPublicKey, '0', 1)

    const reDerived = await derivePasskeyKeyPair(prf)
    const { ak: opened } = await unwrapAK(wrapped, reDerived.ecdhPrivateKey, reDerived.mlkemSecretKey)
    expect(opened).toBeDefined()
  })
})

describe('deriveSealedPasskeyKeyPair', () => {
  // A wire contract like the legacy vector above, under the v2 labels.
  it('matches the frozen known-answer vector', async () => {
    const kp = await deriveSealedPasskeyKeyPair(new Uint8Array(32).fill(1))
    expect(await exportPublicKey(kp.ecdhPublicKey)).toBe(
      'BJ1p9ezTKPG/YWrUwXFrLz8/317oO03+Pm/z6HWsHiIPzc0gc4dfm3Hj0jUsL29JRj0gG28UfZVA95mI5srLv9U=',
    )
    expect(await sha256Hex(kp.mlkemPublicKey)).toBe('44045594b5b1c05de344538cfee9077f12c2f37e7abe24af7cfae04bfebd980f')
  })

  it('derives keys a legacy slot for the same passkey never has', async () => {
    const prf = new Uint8Array(32).fill(1)
    const sealed = await deriveSealedPasskeyKeyPair(prf)
    const legacy = await derivePasskeyKeyPair(prf)
    expect(await exportPublicKey(sealed.ecdhPublicKey)).not.toBe(await exportPublicKey(legacy.ecdhPublicKey))
    expect(exportMlKemPublicKey(sealed.mlkemPublicKey)).not.toBe(exportMlKemPublicKey(legacy.mlkemPublicKey))
  })
})

const userId = 'user-1'
const credentialId = 'credential-1'
const prf = randomPrfOutput()
const sealedKeys = await deriveSealedPasskeyKeyPair(prf)
const dek0 = await generateDEK(false)
const sealed = await sealPasskeyContinuity(dek0, sealedKeys.continuityKey, userId, credentialId)

// The first character's bits are all significant; a trailing one may be base64 padding.
const flipFirstChar = (part: string) => `${part[0] === 'A' ? 'B' : 'A'}${part.slice(1)}`

describe('passkey continuity seal', () => {
  it('holds for the DEK "0", passkey, account and credential it was made for', async () => {
    expect(await passkeyContinuityHolds(sealed, dek0, sealedKeys.continuityKey, userId, credentialId)).toBe(true)
  })

  it('fails for another passkey, DEK "0", account or credential', async () => {
    const otherKeys = await deriveSealedPasskeyKeyPair(randomPrfOutput())
    expect(await passkeyContinuityHolds(sealed, dek0, otherKeys.continuityKey, userId, credentialId)).toBe(false)
    expect(
      await passkeyContinuityHolds(sealed, await generateDEK(false), sealedKeys.continuityKey, userId, credentialId),
    ).toBe(false)
    expect(await passkeyContinuityHolds(sealed, dek0, sealedKeys.continuityKey, 'user-2', credentialId)).toBe(false)
    expect(await passkeyContinuityHolds(sealed, dek0, sealedKeys.continuityKey, userId, 'credential-2')).toBe(false)
  })

  it.each([0, 1, 2])('fails when part %p of the seal is altered', async (index) => {
    const parts = sealed.split(':')
    parts[index] = flipFirstChar(parts[index]!)
    expect(await passkeyContinuityHolds(parts.join(':'), dek0, sealedKeys.continuityKey, userId, credentialId)).toBe(
      false,
    )
  })

  it.each([null, undefined, '', `${sealed}:extra`])(
    'fails closed on the missing or malformed seal %p',
    async (served) => {
      expect(await passkeyContinuityHolds(served, dek0, sealedKeys.continuityKey, userId, credentialId)).toBe(false)
    },
  )

  it('does not accept a recovery seal made from the same inputs', async () => {
    const recoverySeal = await sealRecoveryContinuity(dek0, sealedKeys.continuityKey, userId)
    expect(await passkeyContinuityHolds(recoverySeal, dek0, sealedKeys.continuityKey, userId, credentialId)).toBe(false)
  })
})
