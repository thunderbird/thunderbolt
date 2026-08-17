/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { canaryAAD, ecdsaKeyAlgorithm, ecdsaSignAlgorithm, encodeChallengePayload } from '@shared/e2ee-types'

import { createCanary, verifyCanary, recoverCanarySecretV1, deriveSigningKeyPair, signChallenge } from './canary'
import { base64ToUint8Array, decrypt, encrypt, generateDEK } from './primitives'

const userId = 'user-123'
const keyId = '0'

describe('createCanary', () => {
  it('returns canaryIv, canaryCtext, and a 64-hex-char secret', async () => {
    const canary = await createCanary(await generateDEK(), userId, keyId)
    expect(typeof canary.canaryIv).toBe('string')
    expect(typeof canary.canaryCtext).toBe('string')
    expect(canary.canarySecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique secrets each time', async () => {
    const dek = await generateDEK()
    const c1 = await createCanary(dek, userId, keyId)
    const c2 = await createCanary(dek, userId, keyId)
    expect(c1.canarySecret).not.toBe(c2.canarySecret)
  })

  it('binds canaryAAD(userId, keyId) — decrypts only with that exact AAD', async () => {
    const dek = await generateDEK()
    const canary = await createCanary(dek, userId, keyId)
    const data = { iv: canary.canaryIv, ciphertext: canary.canaryCtext }

    await expect(decrypt(data, dek)).rejects.toThrow('Failed to decrypt')
    await expect(decrypt(data, dek, canaryAAD(userId, '1'))).rejects.toThrow('Failed to decrypt')
    const plaintext = await decrypt(data, dek, canaryAAD(userId, keyId))
    expect(plaintext.startsWith('thunderbolt-canary-v2:')).toBe(true)
  })
})

describe('verifyCanary', () => {
  it('returns valid with the canarySecret when using the correct DEK + context', async () => {
    const dek = await generateDEK()
    const canary = await createCanary(dek, userId, keyId)
    const result = await verifyCanary(dek, userId, keyId, canary.canaryIv, canary.canaryCtext)
    expect(result.valid).toBe(true)
    expect(result.canarySecret).toBe(canary.canarySecret)
  })

  it('returns invalid with the wrong DEK', async () => {
    const canary = await createCanary(await generateDEK(), userId, keyId)
    const result = await verifyCanary(await generateDEK(), userId, keyId, canary.canaryIv, canary.canaryCtext)
    expect(result.valid).toBe(false)
    expect(result.canarySecret).toBeUndefined()
  })

  it('returns invalid when the AAD context (userId/keyId) does not match', async () => {
    const dek = await generateDEK()
    const canary = await createCanary(dek, userId, keyId)
    expect((await verifyCanary(dek, 'other-user', keyId, canary.canaryIv, canary.canaryCtext)).valid).toBe(false)
    expect((await verifyCanary(dek, userId, '1', canary.canaryIv, canary.canaryCtext)).valid).toBe(false)
  })
})

describe('recoverCanarySecretV1 (D1 upgrade possession proof)', () => {
  it('recovers the canarySecret from a v1 canary via a NO-AAD CK decrypt', async () => {
    const legacyCK = await generateDEK()
    const secret = 'deadbeef'.repeat(8)
    // v1 canary was written with NO AAD.
    const { iv, ciphertext } = await encrypt(`thunderbolt-canary-v1:${secret}`, legacyCK)

    expect(await recoverCanarySecretV1(legacyCK, iv, ciphertext)).toBe(secret)
  })

  it('returns null when the CK cannot decrypt the canary', async () => {
    const { iv, ciphertext } = await encrypt('thunderbolt-canary-v1:abc', await generateDEK())
    expect(await recoverCanarySecretV1(await generateDEK(), iv, ciphertext)).toBeNull()
  })

  it('returns null when the decrypted value lacks the v1 prefix', async () => {
    const ck = await generateDEK()
    const { iv, ciphertext } = await encrypt('not-a-canary', ck)
    expect(await recoverCanarySecretV1(ck, iv, ciphertext)).toBeNull()
  })
})

describe('deriveSigningKeyPair', () => {
  it('is deterministic: same canarySecret yields the identical keypair', async () => {
    const { canarySecret } = await createCanary(await generateDEK(), userId, keyId)
    const kp1 = await deriveSigningKeyPair(canarySecret)
    const kp2 = await deriveSigningKeyPair(canarySecret)
    expect(kp1.privateKey).toEqual(kp2.privateKey)
    expect(kp1.publicKeySpki).toBe(kp2.publicKeySpki)
  })

  it('different secrets yield different keypairs', async () => {
    const kp1 = await deriveSigningKeyPair('a'.repeat(64))
    const kp2 = await deriveSigningKeyPair('b'.repeat(64))
    expect(kp1.publicKeySpki).not.toBe(kp2.publicKeySpki)
  })

  it('exports a WebCrypto-importable base64 SPKI public key', async () => {
    const { publicKeySpki } = await deriveSigningKeyPair('c'.repeat(64))
    const imported = await crypto.subtle.importKey(
      'spki',
      base64ToUint8Array(publicKeySpki),
      ecdsaKeyAlgorithm,
      false,
      ['verify'],
    )
    expect(imported.algorithm.name).toBe('ECDSA')
  })
})

describe('signChallenge', () => {
  const importPublicKey = async (spki: string): Promise<CryptoKey> =>
    crypto.subtle.importKey('spki', base64ToUint8Array(spki), ecdsaKeyAlgorithm, false, ['verify'])

  it("verifies through WebCrypto's exact backend verify path", async () => {
    const canarySecret = 'd'.repeat(64)
    const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

    const signature = base64ToUint8Array(await signChallenge(canarySecret, 'nonce-123', 'revoke', 'device-abc'))
    expect(signature.length).toBe(64) // IEEE P1363 raw r||s

    const valid = await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      await importPublicKey(publicKeySpki),
      signature,
      encodeChallengePayload('nonce-123', 'revoke', 'device-abc') as BufferSource,
    )
    expect(valid).toBe(true)
  })

  it('fails verification for a tampered payload', async () => {
    const canarySecret = 'e'.repeat(64)
    const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)
    const publicKey = await importPublicKey(publicKeySpki)
    const signature = base64ToUint8Array(await signChallenge(canarySecret, 'nonce-123', 'revoke', 'device-abc'))

    for (const payload of [
      encodeChallengePayload('nonce-456', 'revoke', 'device-abc'),
      encodeChallengePayload('nonce-123', 'approve', 'device-abc'),
      encodeChallengePayload('nonce-123', 'revoke', 'device-xyz'),
    ]) {
      expect(await crypto.subtle.verify(ecdsaSignAlgorithm, publicKey, signature, payload as BufferSource)).toBe(false)
    }
  })
})
