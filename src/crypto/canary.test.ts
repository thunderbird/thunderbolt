/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { ecdsaKeyAlgorithm, ecdsaSignAlgorithm, encodeChallengePayload } from '@shared/e2ee-types'

import { canaryAAD, createCanary, verifyCanary, deriveSigningKeyPair, signChallenge } from './canary'
import { base64ToUint8Array, decrypt, encrypt, generateDEK } from './primitives'

describe('createCanary', () => {
  it('returns canaryIv, canaryCtext, and canarySecret', async () => {
    const dek0 = await generateDEK()
    const canary = await createCanary(dek0)
    expect(typeof canary.canaryIv).toBe('string')
    expect(typeof canary.canaryCtext).toBe('string')
    // Secret should be 64 hex chars (32 bytes)
    expect(canary.canarySecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique secrets each time', async () => {
    const dek0 = await generateDEK()
    const canary1 = await createCanary(dek0)
    const canary2 = await createCanary(dek0)
    expect(canary1.canarySecret).not.toBe(canary2.canarySecret)
  })

  it('binds the pinned AAD (ciphertext decrypts only with canaryAAD)', async () => {
    const dek0 = await generateDEK()
    const canary = await createCanary(dek0)
    const data = { iv: canary.canaryIv, ciphertext: canary.canaryCtext }

    await expect(decrypt(data, dek0)).rejects.toThrow('Failed to decrypt')
    const plaintext = await decrypt(data, dek0, canaryAAD)
    expect(plaintext.startsWith('thunderbolt-canary-v2:')).toBe(true)
  })
})

describe('verifyCanary', () => {
  it('returns valid with canarySecret when using the correct DEK', async () => {
    const dek0 = await generateDEK()
    const canary = await createCanary(dek0)
    const result = await verifyCanary(dek0, canary.canaryIv, canary.canaryCtext)
    expect(result.valid).toBe(true)
    expect(result.canarySecret).toBe(canary.canarySecret)
  })

  it('returns invalid with no secret when using the wrong DEK', async () => {
    const dek1 = await generateDEK()
    const dek2 = await generateDEK()
    const canary = await createCanary(dek1)
    const result = await verifyCanary(dek2, canary.canaryIv, canary.canaryCtext)
    expect(result.valid).toBe(false)
    expect(result.canarySecret).toBeUndefined()
  })

  it('returns invalid for a ciphertext encrypted under a different AAD', async () => {
    const dek0 = await generateDEK()
    const tamperedAad = new TextEncoder().encode('not-the-canary-aad')
    const { iv, ciphertext } = await encrypt('thunderbolt-canary-v2:deadbeef', dek0, tamperedAad)
    const result = await verifyCanary(dek0, iv, ciphertext)
    expect(result.valid).toBe(false)
  })
})

describe('deriveSigningKeyPair', () => {
  it('is deterministic: same canarySecret yields the identical keypair', async () => {
    const dek0 = await generateDEK()
    const { canarySecret } = await createCanary(dek0)

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
  const importPublicKey = async (publicKeySpki: string): Promise<CryptoKey> =>
    crypto.subtle.importKey('spki', base64ToUint8Array(publicKeySpki), ecdsaKeyAlgorithm, false, ['verify'])

  it("verifies through WebCrypto's exact backend verify path", async () => {
    const canarySecret = 'd'.repeat(64)
    const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)

    const signature = await signChallenge(canarySecret, 'nonce-123', 'revoke', 'device-abc')
    const signatureBytes = base64ToUint8Array(signature)
    expect(signatureBytes.length).toBe(64) // IEEE P1363 raw r||s

    const publicKey = await importPublicKey(publicKeySpki)
    const valid = await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      publicKey,
      signatureBytes,
      encodeChallengePayload('nonce-123', 'revoke', 'device-abc') as BufferSource,
    )
    expect(valid).toBe(true)
  })

  it('fails verification for a tampered payload', async () => {
    const canarySecret = 'e'.repeat(64)
    const { publicKeySpki } = await deriveSigningKeyPair(canarySecret)
    const publicKey = await importPublicKey(publicKeySpki)
    const signature = base64ToUint8Array(await signChallenge(canarySecret, 'nonce-123', 'revoke', 'device-abc'))

    const tamperedNonce = await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      publicKey,
      signature,
      encodeChallengePayload('nonce-456', 'revoke', 'device-abc') as BufferSource,
    )
    expect(tamperedNonce).toBe(false)

    const tamperedOperation = await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      publicKey,
      signature,
      encodeChallengePayload('nonce-123', 'approve', 'device-abc') as BufferSource,
    )
    expect(tamperedOperation).toBe(false)

    const tamperedDevice = await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      publicKey,
      signature,
      encodeChallengePayload('nonce-123', 'revoke', 'device-xyz') as BufferSource,
    )
    expect(tamperedDevice).toBe(false)
  })

  it('fails verification against a different account signing key', async () => {
    const signature = base64ToUint8Array(await signChallenge('f'.repeat(64), 'nonce-1', 'rotate', 'device-1'))
    const { publicKeySpki } = await deriveSigningKeyPair('0'.repeat(64))
    const otherPublicKey = await importPublicKey(publicKeySpki)

    const valid = await crypto.subtle.verify(
      ecdsaSignAlgorithm,
      otherPublicKey,
      signature,
      encodeChallengePayload('nonce-1', 'rotate', 'device-1') as BufferSource,
    )
    expect(valid).toBe(false)
  })
})
