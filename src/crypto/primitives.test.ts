/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  generateKeyPair,
  generateMlKemKeyPair,
  generateCK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  wrapCK,
  rewrapCK,
  unwrapCK,
  encrypt,
  decrypt,
} from './primitives'

describe('generateKeyPair', () => {
  it('generates an ECDH P-256 key pair', async () => {
    const keyPair = await generateKeyPair()
    expect(keyPair.publicKey).toBeDefined()
    expect(keyPair.privateKey).toBeDefined()
    expect(keyPair.publicKey.algorithm.name).toBe('ECDH')
    expect(keyPair.privateKey.extractable).toBe(false)
  })
})

describe('generateMlKemKeyPair', () => {
  it('generates an ML-KEM-768 key pair with correct sizes', () => {
    const keyPair = generateMlKemKeyPair()
    expect(keyPair.publicKey).toBeInstanceOf(Uint8Array)
    expect(keyPair.secretKey).toBeInstanceOf(Uint8Array)
    expect(keyPair.publicKey.length).toBe(1184)
    expect(keyPair.secretKey.length).toBe(2400)
  })

  it('generates different key pairs each time', () => {
    const kp1 = generateMlKemKeyPair()
    const kp2 = generateMlKemKeyPair()
    expect(kp1.publicKey).not.toEqual(kp2.publicKey)
    expect(kp1.secretKey).not.toEqual(kp2.secretKey)
  })
})

describe('exportMlKemPublicKey / importMlKemPublicKey', () => {
  it('round-trips an ML-KEM public key through base64', () => {
    const keyPair = generateMlKemKeyPair()
    const exported = exportMlKemPublicKey(keyPair.publicKey)
    expect(typeof exported).toBe('string')
    expect(exported.length).toBeGreaterThan(0)

    const imported = importMlKemPublicKey(exported)
    expect(imported).toBeInstanceOf(Uint8Array)
    expect(imported).toEqual(keyPair.publicKey)
  })
})

describe('generateCK', () => {
  it('generates a non-extractable AES-GCM key by default', async () => {
    const ck = await generateCK()
    expect(ck.algorithm.name).toBe('AES-GCM')
    expect(ck.extractable).toBe(false)
  })

  it('generates an extractable key when requested', async () => {
    const ck = await generateCK(true)
    expect(ck.extractable).toBe(true)
  })
})

describe('reimportAsNonExtractable', () => {
  it('converts an extractable key to non-extractable', async () => {
    const extractable = await generateCK(true)
    const nonExtractable = await reimportAsNonExtractable(extractable)
    expect(nonExtractable.extractable).toBe(false)
    expect(nonExtractable.algorithm.name).toBe('AES-GCM')
  })
})

describe('exportPublicKey / importPublicKey', () => {
  it('round-trips a public key through base64', async () => {
    const keyPair = await generateKeyPair()
    const exported = await exportPublicKey(keyPair.publicKey)
    expect(typeof exported).toBe('string')
    expect(exported.length).toBeGreaterThan(0)

    const imported = await importPublicKey(exported)
    expect(imported.algorithm.name).toBe('ECDH')
  })
})

describe('wrapCK / unwrapCK', () => {
  // CK must be extractable for wrapKey in Bun/Node (strict Web Crypto spec).
  // In browsers, wrapKey works with non-extractable keys too.
  // The first-device flow always wraps an extractable CK before re-importing.

  it('round-trips CK through wrap and unwrap', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ck = await generateCK(true) // extractable for wrapping

    const wrapped = await wrapCK(ck, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    expect(typeof wrapped).toBe('string')

    const unwrapped = await unwrapCK(wrapped, ecdhKeyPair.privateKey, mlkemKeyPair.secretKey)
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
    expect(unwrapped.extractable).toBe(false)
  })

  it('unwrapped CK can encrypt/decrypt the same data as original', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ck = await generateCK(true)

    const encrypted = await encrypt('wrap test', ck)
    const wrapped = await wrapCK(ck, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    const unwrapped = await unwrapCK(wrapped, ecdhKeyPair.privateKey, mlkemKeyPair.secretKey)

    const decrypted = await decrypt(encrypted, unwrapped)
    expect(decrypted).toBe('wrap test')
  })

  it('produces different wrapped values for different key pairs', async () => {
    const ecdhKeyPair1 = await generateKeyPair()
    const mlkemKeyPair1 = generateMlKemKeyPair()
    const ecdhKeyPair2 = await generateKeyPair()
    const mlkemKeyPair2 = generateMlKemKeyPair()
    const ck = await generateCK(true)

    const wrapped1 = await wrapCK(ck, ecdhKeyPair1.publicKey, mlkemKeyPair1.publicKey)
    const wrapped2 = await wrapCK(ck, ecdhKeyPair2.publicKey, mlkemKeyPair2.publicKey)
    expect(wrapped1).not.toBe(wrapped2)
  })

  it('produces different wrapped values for the same key pair (ephemeral key)', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ck = await generateCK(true)

    const wrapped1 = await wrapCK(ck, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    const wrapped2 = await wrapCK(ck, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    expect(wrapped1).not.toBe(wrapped2)
  })

  it('produces hybrid envelopes with version byte', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ck = await generateCK(true)
    const wrapped = await wrapCK(ck, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)

    // Hybrid envelope: 1 (version) + 65 (ephPub) + 1088 (mlkemCt) + 40 (wrappedCK) = 1194 bytes
    // base64 of 1194 bytes = ceil(1194/3)*4 = 1592 chars
    expect(wrapped.length).toBe(1592)
  })
})

describe('rewrapCK', () => {
  it('rewraps CK from one key pair to another', async () => {
    const ecdhKeyPair1 = await generateKeyPair()
    const mlkemKeyPair1 = generateMlKemKeyPair()
    const ecdhKeyPair2 = await generateKeyPair()
    const mlkemKeyPair2 = generateMlKemKeyPair()
    const ck = await generateCK(true)

    // Wrap CK with keyPair1's public keys (simulates the envelope on the server)
    const wrapped = await wrapCK(ck, ecdhKeyPair1.publicKey, mlkemKeyPair1.publicKey)

    // Rewrap for keyPair2 (simulates approving a new device)
    const rewrapped = await rewrapCK(
      wrapped,
      ecdhKeyPair1.privateKey,
      mlkemKeyPair1.secretKey,
      ecdhKeyPair2.publicKey,
      mlkemKeyPair2.publicKey,
    )
    expect(typeof rewrapped).toBe('string')

    // keyPair2 should be able to unwrap it
    const unwrapped = await unwrapCK(rewrapped, ecdhKeyPair2.privateKey, mlkemKeyPair2.secretKey)
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
  })

  it('rewrapped CK decrypts data encrypted with the original', async () => {
    const ecdhKeyPair1 = await generateKeyPair()
    const mlkemKeyPair1 = generateMlKemKeyPair()
    const ecdhKeyPair2 = await generateKeyPair()
    const mlkemKeyPair2 = generateMlKemKeyPair()
    const ck = await generateCK(true)

    const encrypted = await encrypt('rewrap test', ck)
    const wrapped = await wrapCK(ck, ecdhKeyPair1.publicKey, mlkemKeyPair1.publicKey)
    const rewrapped = await rewrapCK(
      wrapped,
      ecdhKeyPair1.privateKey,
      mlkemKeyPair1.secretKey,
      ecdhKeyPair2.publicKey,
      mlkemKeyPair2.publicKey,
    )
    const unwrapped = await unwrapCK(rewrapped, ecdhKeyPair2.privateKey, mlkemKeyPair2.secretKey)

    const decrypted = await decrypt(encrypted, unwrapped)
    expect(decrypted).toBe('rewrap test')
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips plaintext through encrypt and decrypt', async () => {
    const ck = await generateCK()
    const plaintext = 'Hello, encryption!'

    const encrypted = await encrypt(plaintext, ck)
    expect(encrypted.iv).toBeDefined()
    expect(encrypted.ciphertext).toBeDefined()

    const decrypted = await decrypt(encrypted, ck)
    expect(decrypted).toBe(plaintext)
  })

  it('produces different ciphertext for the same plaintext (unique IV)', async () => {
    const ck = await generateCK()
    const plaintext = 'Same text'

    const encrypted1 = await encrypt(plaintext, ck)
    const encrypted2 = await encrypt(plaintext, ck)
    expect(encrypted1.iv).not.toBe(encrypted2.iv)
    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext)
  })

  it('fails to decrypt with a different key', async () => {
    const ck1 = await generateCK()
    const ck2 = await generateCK()

    const encrypted = await encrypt('secret', ck1)
    await expect(decrypt(encrypted, ck2)).rejects.toThrow('Failed to decrypt')
  })
})
