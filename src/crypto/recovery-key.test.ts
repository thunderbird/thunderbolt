/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { kdfIterations } from '@shared/e2ee-types'

import {
  generateRecoverySeed,
  encodeRecoverySeed,
  decodeRecoveryKey,
  deriveAKFromSeed,
  generateKdfSalt,
} from './recovery-key'
import { base64ToUint8Array, generateDEK, unwrapDEK, wrapDEK } from './primitives'

describe('generateRecoverySeed', () => {
  it('produces 32 random bytes', () => {
    const seed = generateRecoverySeed()
    expect(seed).toBeInstanceOf(Uint8Array)
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
    const mnemonic = encodeRecoverySeed(seed)
    expect(decodeRecoveryKey(mnemonic)).toEqual(seed)
  })

  it('accepts extra whitespace in the input', () => {
    const seed = generateRecoverySeed()
    const mnemonic = encodeRecoverySeed(seed)
    const withExtraSpaces = `  ${mnemonic.replace(/ /g, '   ')}  `
    expect(decodeRecoveryKey(withExtraSpaces)).toEqual(seed)
  })

  it('accepts mixed case input', () => {
    const seed = generateRecoverySeed()
    const mnemonic = encodeRecoverySeed(seed)
    expect(decodeRecoveryKey(mnemonic.toUpperCase())).toEqual(seed)
  })

  it('rejects an invalid mnemonic (bad checksum)', () => {
    const mnemonic = encodeRecoverySeed(generateRecoverySeed())
    const words = mnemonic.split(' ')
    // Each swap has a 1/256 chance of still having a valid checksum.
    // Try multiple swaps so the test is effectively deterministic.
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
    const fakeWords = Array(24).fill('zzzznotaword').join(' ')
    expect(() => decodeRecoveryKey(fakeWords)).toThrow('Invalid recovery phrase')
  })

  it('rejects wrong word count', () => {
    const mnemonic = encodeRecoverySeed(generateRecoverySeed())
    const tooFew = mnemonic.split(' ').slice(0, 12).join(' ')
    expect(() => decodeRecoveryKey(tooFew)).toThrow()
  })
})

describe('deriveAKFromSeed', () => {
  it('pins the KDF iteration count at 600k', () => {
    expect(kdfIterations).toBe(600_000)
  })

  it('derives a non-extractable AES-KW key with wrap/unwrap usages by default', async () => {
    const ak = await deriveAKFromSeed(generateRecoverySeed(), generateKdfSalt())
    expect(ak.algorithm.name).toBe('AES-KW')
    expect(ak.extractable).toBe(false)
    expect([...ak.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('derives the same AK from the same seed + salt', async () => {
    const seed = generateRecoverySeed()
    const salt = generateKdfSalt()
    const ak1 = await deriveAKFromSeed(seed, salt, { extractable: true })
    const ak2 = await deriveAKFromSeed(seed, salt, { extractable: true })

    const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', ak1))
    const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', ak2))
    expect(raw1).toEqual(raw2)
  })

  it('derives a different AK for a different salt', async () => {
    const seed = generateRecoverySeed()
    const ak1 = await deriveAKFromSeed(seed, generateKdfSalt(), { extractable: true })
    const ak2 = await deriveAKFromSeed(seed, generateKdfSalt(), { extractable: true })

    const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', ak1))
    const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', ak2))
    expect(raw1).not.toEqual(raw2)
  })

  it('derived AK wraps and unwraps a DEK', async () => {
    const seed = generateRecoverySeed()
    const salt = generateKdfSalt()
    const ak = await deriveAKFromSeed(seed, salt)
    const dek = await generateDEK(true)
    const wrapped = await wrapDEK(dek, ak)

    const reDerived = await deriveAKFromSeed(seed, salt)
    const unwrapped = await unwrapDEK(wrapped, reDerived)
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
  })
})

describe('generateKdfSalt', () => {
  it('produces base64 of 32 random bytes', () => {
    const salt = generateKdfSalt()
    expect(base64ToUint8Array(salt).length).toBe(32)
    expect(generateKdfSalt()).not.toBe(salt)
  })
})
