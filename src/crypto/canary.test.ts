/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { ecdsaKeyAlgorithm, ecdsaSignAlgorithm, encodeChallengePayload } from '@shared/e2ee-types'

import {
  mintCanary,
  unwrapCanaryKey,
  recoverCanarySecretV1,
  deriveSigningKeyPair,
  signChallenge,
  signRecoveryAttestation,
  verifyRecoveryAttestation,
} from './canary'
import { base64ToUint8Array, encrypt, generateAK, generateDEK } from './primitives'

const userId = 'user-123'

/** A deterministic HKDF canary key from a fixed seed string (epoch stand-in). */
const canaryKeyFromSeed = (seed: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(seed), 'HKDF', false, ['deriveBits', 'deriveKey'])

describe('mintCanary / unwrapCanaryKey (THU-872 — AK-anchored)', () => {
  it('returns base64 iv/ctext and a non-extractable HKDF key handle', async () => {
    const ak = await generateAK()
    const canary = await mintCanary(ak, userId)
    expect(typeof canary.canaryIv).toBe('string')
    expect(typeof canary.canaryCtext).toBe('string')
    expect(canary.canaryKey.algorithm.name).toBe('HKDF')
    expect(canary.canaryKey.extractable).toBe(false)
  })

  it('mints a fresh seed each time — two canaries under one AK derive different signing keys', async () => {
    const ak = await generateAK()
    const c1 = await mintCanary(ak, userId)
    const c2 = await mintCanary(ak, userId)
    expect(c1.canaryCtext).not.toBe(c2.canaryCtext)
    const kp1 = await deriveSigningKeyPair(c1.canaryKey)
    const kp2 = await deriveSigningKeyPair(c2.canaryKey)
    expect(kp1.publicKeySpki).not.toBe(kp2.publicKeySpki)
  })

  it('round-trips: the served blob unwraps to the same seed the mint returned', async () => {
    const ak = await generateAK()
    const { canaryIv, canaryCtext, canaryKey } = await mintCanary(ak, userId)
    const reopened = await unwrapCanaryKey(ak, userId, canaryIv, canaryCtext)
    // Same seed ⇔ same derived signing keypair (the handle itself is opaque).
    expect((await deriveSigningKeyPair(reopened)).publicKeySpki).toBe(
      (await deriveSigningKeyPair(canaryKey)).publicKeySpki,
    )
  })

  it('does NOT open under a different AK — the revoked-device / old-epoch case', async () => {
    const currentAK = await generateAK()
    const { canaryIv, canaryCtext } = await mintCanary(currentAK, userId)
    const retainedOldAK = await generateAK()
    await expect(unwrapCanaryKey(retainedOldAK, userId, canaryIv, canaryCtext)).rejects.toThrow(
      'Failed to unwrap canary',
    )
  })

  it('does NOT open under another account (userId is bound in the AAD)', async () => {
    const ak = await generateAK()
    const { canaryIv, canaryCtext } = await mintCanary(ak, userId)
    await expect(unwrapCanaryKey(ak, 'other-user', canaryIv, canaryCtext)).rejects.toThrow('Failed to unwrap canary')
  })

  it('rejects garbage blobs loudly', async () => {
    const ak = await generateAK()
    await expect(unwrapCanaryKey(ak, userId, 'AAAA', 'AAAA')).rejects.toThrow('Failed to unwrap canary')
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
  it('is deterministic: the same seed yields the identical keypair', async () => {
    const kp1 = await deriveSigningKeyPair(await canaryKeyFromSeed('seed-a'))
    const kp2 = await deriveSigningKeyPair(await canaryKeyFromSeed('seed-a'))
    expect(kp1.privateKey).toEqual(kp2.privateKey)
    expect(kp1.publicKeySpki).toBe(kp2.publicKeySpki)
  })

  it('different seeds yield different keypairs', async () => {
    const kp1 = await deriveSigningKeyPair(await canaryKeyFromSeed('seed-a'))
    const kp2 = await deriveSigningKeyPair(await canaryKeyFromSeed('seed-b'))
    expect(kp1.publicKeySpki).not.toBe(kp2.publicKeySpki)
  })

  it('exports a WebCrypto-importable base64 SPKI public key', async () => {
    const { publicKeySpki } = await deriveSigningKeyPair(await canaryKeyFromSeed('seed-c'))
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
    const canaryKey = await canaryKeyFromSeed('seed-d')
    const { publicKeySpki } = await deriveSigningKeyPair(canaryKey)

    const signature = base64ToUint8Array(await signChallenge(canaryKey, 'nonce-123', 'revoke', 'device-abc'))
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
    const canaryKey = await canaryKeyFromSeed('seed-e')
    const { publicKeySpki } = await deriveSigningKeyPair(canaryKey)
    const publicKey = await importPublicKey(publicKeySpki)
    const signature = base64ToUint8Array(await signChallenge(canaryKey, 'nonce-123', 'revoke', 'device-abc'))

    for (const payload of [
      encodeChallengePayload('nonce-456', 'revoke', 'device-abc'),
      encodeChallengePayload('nonce-123', 'approve', 'device-abc'),
      encodeChallengePayload('nonce-123', 'revoke', 'device-xyz'),
    ]) {
      expect(await crypto.subtle.verify(ecdsaSignAlgorithm, publicKey, signature, payload as BufferSource)).toBe(false)
    }
  })
})

describe('signRecoveryAttestation / verifyRecoveryAttestation (THU-865)', () => {
  const anchor = {
    userId,
    kdfSalt: 'salt-base64',
    recoveryEcdhPublicKey: 'recovery-ecdh-base64',
    recoveryMlkemPublicKey: 'recovery-mlkem-base64',
  }

  it('round-trips: an anchor signed with a canary key verifies under that key', async () => {
    const canaryKey = await canaryKeyFromSeed('seed-a')
    const attestation = await signRecoveryAttestation(canaryKey, anchor)
    expect(await verifyRecoveryAttestation(canaryKey, attestation, anchor)).toBe(true)
  })

  it('rejects a tampered anchor field — this is the substitution attack', async () => {
    const canaryKey = await canaryKeyFromSeed('seed-b')
    const attestation = await signRecoveryAttestation(canaryKey, anchor)

    // Every field is load-bearing: swapping the ECDH or ML-KEM public key is the
    // recovery-slot hijack itself, and swapping the salt re-derives a different
    // keypair from the same phrase.
    for (const tampered of [
      { ...anchor, recoveryEcdhPublicKey: 'attacker-ecdh' },
      { ...anchor, recoveryMlkemPublicKey: 'attacker-mlkem' },
      { ...anchor, kdfSalt: 'attacker-salt' },
      { ...anchor, userId: 'other-user' },
    ]) {
      expect(await verifyRecoveryAttestation(canaryKey, attestation, tampered)).toBe(false)
    }
  })

  it('rejects an attestation from a different epoch — the signing key rotates with the AK', async () => {
    const attestation = await signRecoveryAttestation(await canaryKeyFromSeed('seed-c'), anchor)
    expect(await verifyRecoveryAttestation(await canaryKeyFromSeed('seed-d'), attestation, anchor)).toBe(false)
  })

  it('rejects malformed signature bytes rather than throwing', async () => {
    const canaryKey = await canaryKeyFromSeed('seed-e')
    expect(await verifyRecoveryAttestation(canaryKey, 'not-base64-!!', anchor)).toBe(false)
    expect(await verifyRecoveryAttestation(canaryKey, '', anchor)).toBe(false)
  })

  it('does not accept a challenge signature as an attestation (domain separation)', async () => {
    // The nonce is SERVER-chosen, so without the domain tag a malicious server
    // could try to steer a harvested challenge signature into the anchor check.
    const canaryKey = await canaryKeyFromSeed('seed-f')
    const challengeSignature = await signChallenge(canaryKey, 'nonce-123', 'rotate', 'device-abc')
    expect(await verifyRecoveryAttestation(canaryKey, challengeSignature, anchor)).toBe(false)
  })
})
