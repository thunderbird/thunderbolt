/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { kdfIterations } from '@shared/e2ee-types'

import {
  generateRecoverySeed,
  encodeRecoverySeed,
  decodeRecoveryKey,
  deriveRecoveryKeyPairFromSeed,
  generateKdfSalt,
} from './recovery-key'
import {
  base64ToUint8Array,
  exportMlKemPublicKey,
  exportPublicKey,
  generateAK,
  generateDEK,
  unwrapAK,
  unwrapDEK,
  wrapAK,
  wrapDEK,
} from './primitives'

describe('generateRecoverySeed', () => {
  it('produces 32 random bytes', () => {
    const seed = generateRecoverySeed()
    expect(seed.length).toBe(32)
    expect(generateRecoverySeed()).not.toEqual(seed)
  })
})

describe('encodeRecoverySeed', () => {
  it('produces a 24-word lowercase mnemonic', () => {
    const mnemonic = encodeRecoverySeed(generateRecoverySeed())
    expect(mnemonic.split(' ')).toHaveLength(24)
    expect(mnemonic).toBe(mnemonic.toLowerCase())
  })
})

describe('decodeRecoveryKey', () => {
  it('round-trips: encode then decode returns the same seed', () => {
    const seed = generateRecoverySeed()
    expect(decodeRecoveryKey(encodeRecoverySeed(seed))).toEqual(seed)
  })

  it('accepts extra whitespace and mixed case', () => {
    const seed = generateRecoverySeed()
    const mnemonic = encodeRecoverySeed(seed)
    expect(decodeRecoveryKey(`  ${mnemonic.replace(/ /g, '   ')}  `.toUpperCase())).toEqual(seed)
  })

  it('rejects an invalid mnemonic (bad checksum)', () => {
    const words = encodeRecoverySeed(generateRecoverySeed()).split(' ')
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === words[i + 1]) {
        continue
      }
      const corrupted = [...words]
      ;[corrupted[i], corrupted[i + 1]] = [corrupted[i + 1], corrupted[i]]
      try {
        decodeRecoveryKey(corrupted.join(' '))
      } catch {
        return // checksum correctly rejected
      }
    }
    throw new Error('All swaps produced valid checksums (astronomically unlikely)')
  })

  it('rejects a word not in the wordlist', () => {
    expect(() => decodeRecoveryKey(Array(24).fill('zzzznotaword').join(' '))).toThrow('Invalid recovery phrase')
  })

  it('rejects wrong word count', () => {
    const tooFew = encodeRecoverySeed(generateRecoverySeed()).split(' ').slice(0, 12).join(' ')
    expect(() => decodeRecoveryKey(tooFew)).toThrow()
  })
})

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')

/**
 * Frozen known-answer vectors. These are the regression guard against a
 * @noble upgrade (or a tweak to the HKDF labels / seed widths) silently changing
 * the derivation and bricking every recovery phrase in the wild. The ML-KEM
 * public key is 1184 bytes, so it is pinned by SHA-256 digest rather than inline
 * base64. Regenerate ONLY if the derivation is intentionally versioned.
 */
const knownAnswerVectors = [
  {
    seed: new Uint8Array(32).map((_, i) => i),
    salt: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    ecdhPublicKey: 'BHmvSqzg61OLZow7msmuOyXYRRHzqkJONoA53cO3B9+FBU4JdVDinJz33YE6ve3Ka1VJ7gZtsAmi2TeJW3h5M7w=',
    mlkemPublicKeySha256: 'a2e6a19a9d8aeb29966d9219a83270c03005bb9f87a42cbff9e0f33f3ee15ac0',
  },
  {
    seed: new Uint8Array(32).fill(0xab),
    salt: 'XFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFw=',
    ecdhPublicKey: 'BOFgP2TkLLj7xuP6OBLg7pRhoYVl6eyDoZgI0WwOotIIuKoOD+1WK5WFm7Y8xUdOebtX3pz+4qSAS1A1mVl/RiI=',
    mlkemPublicKeySha256: 'eb9339551aa159ea887126043a5e29a36fbd4c332ad32e8f2eeb584bb86aa431',
  },
]

describe('deriveRecoveryKeyPairFromSeed', () => {
  it('pins the KDF iteration count at 600k', () => {
    expect(kdfIterations).toBe(600_000)
  })

  it('produces a StoredKeyPair-shaped hybrid keypair', async () => {
    const kp = await deriveRecoveryKeyPairFromSeed(generateRecoverySeed(), generateKdfSalt())
    expect(kp.ecdhPublicKey.algorithm.name).toBe('ECDH')
    expect(kp.ecdhPrivateKey.type).toBe('private')
    expect(kp.ecdhPrivateKey.extractable).toBe(false)
    expect([...kp.ecdhPrivateKey.usages]).toEqual(['deriveBits'])
    expect(kp.mlkemPublicKey.length).toBe(1184)
    expect(kp.mlkemSecretKey.length).toBe(2400)
  })

  it('derives byte-identical public keys from the same seed + salt', async () => {
    const seed = generateRecoverySeed()
    const salt = generateKdfSalt()
    const first = await deriveRecoveryKeyPairFromSeed(seed, salt)
    const second = await deriveRecoveryKeyPairFromSeed(seed, salt)
    expect(await exportPublicKey(second.ecdhPublicKey)).toBe(await exportPublicKey(first.ecdhPublicKey))
    expect(exportMlKemPublicKey(second.mlkemPublicKey)).toBe(exportMlKemPublicKey(first.mlkemPublicKey))
    expect(second.mlkemSecretKey).toEqual(first.mlkemSecretKey)
  })

  it.each(knownAnswerVectors)('matches the frozen known-answer vector for salt $salt', async (vector) => {
    const kp = await deriveRecoveryKeyPairFromSeed(vector.seed, vector.salt)
    expect(await exportPublicKey(kp.ecdhPublicKey)).toBe(vector.ecdhPublicKey)
    expect(await sha256Hex(kp.mlkemPublicKey)).toBe(vector.mlkemPublicKeySha256)
  })

  it('derives a different keypair for a different salt', async () => {
    const seed = generateRecoverySeed()
    const first = await deriveRecoveryKeyPairFromSeed(seed, generateKdfSalt())
    const second = await deriveRecoveryKeyPairFromSeed(seed, generateKdfSalt())
    expect(await exportPublicKey(second.ecdhPublicKey)).not.toBe(await exportPublicKey(first.ecdhPublicKey))
    expect(exportMlKemPublicKey(second.mlkemPublicKey)).not.toBe(exportMlKemPublicKey(first.mlkemPublicKey))
  })

  it('derives a different keypair for a different seed', async () => {
    const salt = generateKdfSalt()
    const first = await deriveRecoveryKeyPairFromSeed(generateRecoverySeed(), salt)
    const second = await deriveRecoveryKeyPairFromSeed(generateRecoverySeed(), salt)
    expect(await exportPublicKey(second.ecdhPublicKey)).not.toBe(await exportPublicKey(first.ecdhPublicKey))
  })

  it('round-trips an AK through wrapAK / unwrapAK across independent derivations', async () => {
    const seed = generateRecoverySeed()
    const salt = generateKdfSalt()
    const wrapper = await deriveRecoveryKeyPairFromSeed(seed, salt)
    const envelope = await wrapAK(await generateAK(true), wrapper.ecdhPublicKey, wrapper.mlkemPublicKey)

    const unwrapper = await deriveRecoveryKeyPairFromSeed(seed, salt)
    const ak = await unwrapAK(envelope, unwrapper.ecdhPrivateKey, unwrapper.mlkemSecretKey)
    expect(ak.algorithm.name).toBe('AES-KW')

    const dek = await generateDEK(true)
    expect((await unwrapDEK(await wrapDEK(dek, ak), ak)).algorithm.name).toBe('AES-GCM')
  })

  it('cannot unwrap an envelope sealed to a different phrase', async () => {
    const salt = generateKdfSalt()
    const wrapper = await deriveRecoveryKeyPairFromSeed(generateRecoverySeed(), salt)
    const envelope = await wrapAK(await generateAK(true), wrapper.ecdhPublicKey, wrapper.mlkemPublicKey)

    const other = await deriveRecoveryKeyPairFromSeed(generateRecoverySeed(), salt)
    await expect(unwrapAK(envelope, other.ecdhPrivateKey, other.mlkemSecretKey)).rejects.toThrow(
      'Failed to unwrap account key',
    )
  })
})

describe('generateKdfSalt', () => {
  it('produces base64 of 32 random bytes', () => {
    const salt = generateKdfSalt()
    expect(base64ToUint8Array(salt).length).toBe(32)
    expect(generateKdfSalt()).not.toBe(salt)
  })
})
