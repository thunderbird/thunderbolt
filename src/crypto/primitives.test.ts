/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  generateKeyPair,
  generateMlKemKeyPair,
  generateAK,
  generateDEK,
  mintDEK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  exportMlKemPublicKey,
  importMlKemPublicKey,
  deriveMlKemAtRestKey,
  wrapAK,
  rewrapAK,
  unwrapAK,
  wrapDEK,
  unwrapDEK,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  base64ToUint8Array,
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

describe('generateAK', () => {
  it('generates a non-extractable AES-KW key with wrap/unwrap usages only', async () => {
    const ak = await generateAK()
    expect(ak.algorithm.name).toBe('AES-KW')
    expect(ak.extractable).toBe(false)
    expect([...ak.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('generates an extractable key when requested', async () => {
    const ak = await generateAK(true)
    expect(ak.extractable).toBe(true)
  })

  it('cannot encrypt data (usage separation is the point)', async () => {
    const ak = await generateAK()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    await expect(crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ak, new TextEncoder().encode('nope'))).rejects.toThrow()
  })
})

describe('generateDEK', () => {
  it('generates a non-extractable AES-GCM key with encrypt/decrypt usages only', async () => {
    const dek = await generateDEK()
    expect(dek.algorithm.name).toBe('AES-GCM')
    expect(dek.extractable).toBe(false)
    expect([...dek.usages].sort()).toEqual(['decrypt', 'encrypt'])
  })

  it('cannot wrap keys', async () => {
    const dek = await generateDEK()
    const other = await generateDEK(true)
    await expect(crypto.subtle.wrapKey('raw', other, dek, 'AES-KW')).rejects.toThrow()
  })
})

describe('reimportAsNonExtractable', () => {
  it('converts an extractable AK to a non-extractable AES-KW key', async () => {
    const extractable = await generateAK(true)
    const nonExtractable = await reimportAsNonExtractable(extractable)
    expect(nonExtractable.extractable).toBe(false)
    expect(nonExtractable.algorithm.name).toBe('AES-KW')
    expect([...nonExtractable.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('reimported AK unwraps a DEK wrapped by the original', async () => {
    const extractableAK = await generateAK(true)
    const dek = await generateDEK(true)
    const wrapped = await wrapDEK(dek, extractableAK)
    const nonExtractableAK = await reimportAsNonExtractable(extractableAK)
    const unwrapped = await unwrapDEK(wrapped, nonExtractableAK)
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
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

describe('wrapDEK / unwrapDEK', () => {
  it('round-trips a DEK: data encrypted before wrap decrypts after unwrap', async () => {
    const ak = await generateAK()
    const dek = await generateDEK(true)
    const encrypted = await encrypt('dek round trip', dek)

    const wrapped = await wrapDEK(dek, ak)
    expect(typeof wrapped).toBe('string')

    const unwrapped = await unwrapDEK(wrapped, ak)
    expect(unwrapped.extractable).toBe(false)
    expect([...unwrapped.usages].sort()).toEqual(['decrypt', 'encrypt'])
    expect(await decrypt(encrypted, unwrapped)).toBe('dek round trip')
  })

  it('fails to unwrap with a different AK', async () => {
    const ak1 = await generateAK()
    const ak2 = await generateAK()
    const dek = await generateDEK(true)
    const wrapped = await wrapDEK(dek, ak1)
    await expect(unwrapDEK(wrapped, ak2)).rejects.toThrow('Failed to unwrap DEK')
  })

  it('fails to wrap a non-extractable DEK', async () => {
    const ak = await generateAK()
    const dek = await generateDEK()
    await expect(wrapDEK(dek, ak)).rejects.toThrow('Failed to wrap DEK')
  })
})

describe('mintDEK', () => {
  it('returns a non-extractable DEK that matches the wrapped blob', async () => {
    const ak = await generateAK()
    const { dek, wrappedKey } = await mintDEK(ak)
    expect(dek.extractable).toBe(false)

    const encrypted = await encrypt('minted', dek)
    const reUnwrapped = await unwrapDEK(wrappedKey, ak)
    expect(await decrypt(encrypted, reUnwrapped)).toBe('minted')
  })
})

describe('wrapAK / unwrapAK', () => {
  // The AK must be extractable at wrap time (WebCrypto wrapKey requirement).
  // The first-device flow always wraps an extractable AK before re-importing.

  it('round-trips AK through wrap and unwrap', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ak = await generateAK(true)

    const wrapped = await wrapAK(ak, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    expect(typeof wrapped).toBe('string')

    const unwrapped = await unwrapAK(wrapped, ecdhKeyPair.privateKey, mlkemKeyPair.secretKey)
    expect(unwrapped.algorithm.name).toBe('AES-KW')
    expect(unwrapped.extractable).toBe(false)
    expect([...unwrapped.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('unwrapped AK unwraps a DEK wrapped by the original', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ak = await generateAK(true)
    const dek = await generateDEK(true)

    const encrypted = await encrypt('wrap test', dek)
    const wrappedDek = await wrapDEK(dek, ak)
    const wrappedAk = await wrapAK(ak, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    const unwrappedAk = await unwrapAK(wrappedAk, ecdhKeyPair.privateKey, mlkemKeyPair.secretKey)
    const unwrappedDek = await unwrapDEK(wrappedDek, unwrappedAk)

    expect(await decrypt(encrypted, unwrappedDek)).toBe('wrap test')
  })

  it('produces different wrapped values for different key pairs', async () => {
    const ecdhKeyPair1 = await generateKeyPair()
    const mlkemKeyPair1 = generateMlKemKeyPair()
    const ecdhKeyPair2 = await generateKeyPair()
    const mlkemKeyPair2 = generateMlKemKeyPair()
    const ak = await generateAK(true)

    const wrapped1 = await wrapAK(ak, ecdhKeyPair1.publicKey, mlkemKeyPair1.publicKey)
    const wrapped2 = await wrapAK(ak, ecdhKeyPair2.publicKey, mlkemKeyPair2.publicKey)
    expect(wrapped1).not.toBe(wrapped2)
  })

  it('produces different wrapped values for the same key pair (ephemeral key)', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ak = await generateAK(true)

    const wrapped1 = await wrapAK(ak, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    const wrapped2 = await wrapAK(ak, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)
    expect(wrapped1).not.toBe(wrapped2)
  })

  it('produces the unchanged v1 envelope byte layout and version', async () => {
    const ecdhKeyPair = await generateKeyPair()
    const mlkemKeyPair = generateMlKemKeyPair()
    const ak = await generateAK(true)
    const wrapped = await wrapAK(ak, ecdhKeyPair.publicKey, mlkemKeyPair.publicKey)

    // Hybrid envelope: 1 (version) + 65 (ephPub) + 1088 (mlkemCt) + 40 (wrappedAK) = 1194 bytes
    // base64 of 1194 bytes = ceil(1194/3)*4 = 1592 chars
    expect(wrapped.length).toBe(1592)
    const envelope = base64ToUint8Array(wrapped)
    expect(envelope.length).toBe(1194)
    expect(envelope[0]).toBe(0x01)
  })
})

describe('rewrapAK', () => {
  it('rewraps AK from one device key pair to another', async () => {
    const ecdhKeyPair1 = await generateKeyPair()
    const mlkemKeyPair1 = generateMlKemKeyPair()
    const ecdhKeyPair2 = await generateKeyPair()
    const mlkemKeyPair2 = generateMlKemKeyPair()
    const ak = await generateAK(true)

    // Wrap AK with keyPair1's public keys (simulates the envelope on the server)
    const wrapped = await wrapAK(ak, ecdhKeyPair1.publicKey, mlkemKeyPair1.publicKey)

    // Rewrap for keyPair2 (simulates approving a new device)
    const rewrapped = await rewrapAK(
      wrapped,
      ecdhKeyPair1.privateKey,
      mlkemKeyPair1.secretKey,
      ecdhKeyPair2.publicKey,
      mlkemKeyPair2.publicKey,
    )
    expect(typeof rewrapped).toBe('string')

    // keyPair2 should be able to unwrap it
    const unwrapped = await unwrapAK(rewrapped, ecdhKeyPair2.privateKey, mlkemKeyPair2.secretKey)
    expect(unwrapped.algorithm.name).toBe('AES-KW')
  })

  it('rewrapped AK unwraps a DEK wrapped with the original', async () => {
    const ecdhKeyPair1 = await generateKeyPair()
    const mlkemKeyPair1 = generateMlKemKeyPair()
    const ecdhKeyPair2 = await generateKeyPair()
    const mlkemKeyPair2 = generateMlKemKeyPair()
    const ak = await generateAK(true)
    const dek = await generateDEK(true)

    const encrypted = await encrypt('rewrap test', dek)
    const wrappedDek = await wrapDEK(dek, ak)
    const wrappedAk = await wrapAK(ak, ecdhKeyPair1.publicKey, mlkemKeyPair1.publicKey)
    const rewrapped = await rewrapAK(
      wrappedAk,
      ecdhKeyPair1.privateKey,
      mlkemKeyPair1.secretKey,
      ecdhKeyPair2.publicKey,
      mlkemKeyPair2.publicKey,
    )
    const unwrappedAk = await unwrapAK(rewrapped, ecdhKeyPair2.privateKey, mlkemKeyPair2.secretKey)
    const unwrappedDek = await unwrapDEK(wrappedDek, unwrappedAk)

    expect(await decrypt(encrypted, unwrappedDek)).toBe('rewrap test')
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips plaintext through encrypt and decrypt', async () => {
    const dek = await generateDEK()
    const plaintext = 'Hello, encryption!'

    const encrypted = await encrypt(plaintext, dek)
    expect(encrypted.iv).toBeDefined()
    expect(encrypted.ciphertext).toBeDefined()

    const decrypted = await decrypt(encrypted, dek)
    expect(decrypted).toBe(plaintext)
  })

  it('produces different ciphertext for the same plaintext (unique IV)', async () => {
    const dek = await generateDEK()
    const plaintext = 'Same text'

    const encrypted1 = await encrypt(plaintext, dek)
    const encrypted2 = await encrypt(plaintext, dek)
    expect(encrypted1.iv).not.toBe(encrypted2.iv)
    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext)
  })

  it('fails to decrypt with a different key', async () => {
    const dek1 = await generateDEK()
    const dek2 = await generateDEK()

    const encrypted = await encrypt('secret', dek1)
    await expect(decrypt(encrypted, dek2)).rejects.toThrow('Failed to decrypt')
  })

  it('round-trips with additionalData (AAD)', async () => {
    const dek = await generateDEK()
    const aad = new TextEncoder().encode('table\u001fcolumn\u001frow-1\u001f0')

    const encrypted = await encrypt('aad-bound', dek, aad)
    expect(await decrypt(encrypted, dek, aad)).toBe('aad-bound')
  })

  it('fails to decrypt with the wrong AAD', async () => {
    const dek = await generateDEK()
    const aad = new TextEncoder().encode('right-aad')
    const wrongAad = new TextEncoder().encode('wrong-aad')

    const encrypted = await encrypt('aad-bound', dek, aad)
    await expect(decrypt(encrypted, dek, wrongAad)).rejects.toThrow('Failed to decrypt')
  })

  it('fails to decrypt without AAD when encrypted with AAD (and vice versa)', async () => {
    const dek = await generateDEK()
    const aad = new TextEncoder().encode('some-aad')

    const withAad = await encrypt('one', dek, aad)
    await expect(decrypt(withAad, dek)).rejects.toThrow('Failed to decrypt')

    const withoutAad = await encrypt('two', dek)
    await expect(decrypt(withoutAad, dek, aad)).rejects.toThrow('Failed to decrypt')
  })
})

describe('encryptBytes / decryptBytes', () => {
  it('round-trips raw bytes', async () => {
    const key = await generateDEK()
    const data = crypto.getRandomValues(new Uint8Array(100))

    const encrypted = await encryptBytes(data, key)
    expect(encrypted.iv).toBeInstanceOf(Uint8Array)
    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array)
    expect(encrypted.ciphertext).not.toEqual(data)

    expect(await decryptBytes(encrypted, key)).toEqual(data)
  })

  it('fails with a different key', async () => {
    const key1 = await generateDEK()
    const key2 = await generateDEK()
    const encrypted = await encryptBytes(new Uint8Array([1, 2, 3]), key1)
    await expect(decryptBytes(encrypted, key2)).rejects.toThrow('Failed to decrypt bytes')
  })
})

describe('deriveMlKemAtRestKey', () => {
  it('derives the same key from the same ECDH pair (deterministic self-ECDH)', async () => {
    const keyPair = await generateKeyPair()
    const key1 = await deriveMlKemAtRestKey(keyPair.publicKey, keyPair.privateKey)
    const key2 = await deriveMlKemAtRestKey(keyPair.publicKey, keyPair.privateKey)

    const encrypted = await encryptBytes(new Uint8Array([9, 8, 7]), key1)
    expect(await decryptBytes(encrypted, key2)).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('derives different keys for different ECDH pairs', async () => {
    const keyPair1 = await generateKeyPair()
    const keyPair2 = await generateKeyPair()
    const key1 = await deriveMlKemAtRestKey(keyPair1.publicKey, keyPair1.privateKey)
    const key2 = await deriveMlKemAtRestKey(keyPair2.publicKey, keyPair2.privateKey)

    const encrypted = await encryptBytes(new Uint8Array([1, 2, 3]), key1)
    await expect(decryptBytes(encrypted, key2)).rejects.toThrow('Failed to decrypt bytes')
  })
})
