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
  rewrapKeyring,
  unwrapLegacyCK,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  base64ToUint8Array,
} from './primitives'

describe('generateKeyPair', () => {
  it('generates an ECDH P-256 key pair', async () => {
    const keyPair = await generateKeyPair()
    expect(keyPair.publicKey.algorithm.name).toBe('ECDH')
    expect(keyPair.privateKey.extractable).toBe(false)
  })
})

describe('generateMlKemKeyPair', () => {
  it('generates an ML-KEM-768 key pair with correct sizes', () => {
    const keyPair = generateMlKemKeyPair()
    expect(keyPair.publicKey.length).toBe(1184)
    expect(keyPair.secretKey.length).toBe(2400)
  })

  it('generates different key pairs each time', () => {
    const kp1 = generateMlKemKeyPair()
    const kp2 = generateMlKemKeyPair()
    expect(kp1.secretKey).not.toEqual(kp2.secretKey)
  })
})

describe('exportMlKemPublicKey / importMlKemPublicKey', () => {
  it('round-trips an ML-KEM public key through base64', () => {
    const keyPair = generateMlKemKeyPair()
    const imported = importMlKemPublicKey(exportMlKemPublicKey(keyPair.publicKey))
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
    const nonExtractable = await reimportAsNonExtractable(await generateAK(true))
    expect(nonExtractable.extractable).toBe(false)
    expect(nonExtractable.algorithm.name).toBe('AES-KW')
    expect([...nonExtractable.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('reimported AK unwraps a DEK wrapped by the original', async () => {
    const extractableAK = await generateAK(true)
    const dek = await generateDEK(true)
    const wrapped = await wrapDEK(dek, extractableAK)
    const unwrapped = await unwrapDEK(wrapped, await reimportAsNonExtractable(extractableAK))
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
  })
})

describe('exportPublicKey / importPublicKey', () => {
  it('round-trips a public key through base64', async () => {
    const keyPair = await generateKeyPair()
    const imported = await importPublicKey(await exportPublicKey(keyPair.publicKey))
    expect(imported.algorithm.name).toBe('ECDH')
  })
})

describe('wrapDEK / unwrapDEK', () => {
  it('round-trips a DEK: data encrypted before wrap decrypts after unwrap', async () => {
    const ak = await generateAK()
    const dek = await generateDEK(true)
    const encrypted = await encrypt('dek round trip', dek)

    const unwrapped = await unwrapDEK(await wrapDEK(dek, ak), ak)
    expect(unwrapped.extractable).toBe(false)
    expect([...unwrapped.usages].sort()).toEqual(['decrypt', 'encrypt'])
    expect(await decrypt(encrypted, unwrapped)).toBe('dek round trip')
  })

  it('fails to unwrap with a different AK', async () => {
    const ak1 = await generateAK()
    const ak2 = await generateAK()
    const wrapped = await wrapDEK(await generateDEK(true), ak1)
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
    expect(await decrypt(encrypted, await unwrapDEK(wrappedKey, ak))).toBe('minted')
  })
})

describe('wrapAK / unwrapAK', () => {
  it('round-trips AK through wrap and unwrap', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const ak = await generateAK(true)

    const unwrapped = await unwrapAK(
      await wrapAK(ak, ecdh.publicKey, mlkem.publicKey),
      ecdh.privateKey,
      mlkem.secretKey,
    )
    expect(unwrapped.algorithm.name).toBe('AES-KW')
    expect(unwrapped.extractable).toBe(false)
    expect([...unwrapped.usages].sort()).toEqual(['unwrapKey', 'wrapKey'])
  })

  it('unwrapped AK unwraps a DEK wrapped by the original', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const ak = await generateAK(true)
    const dek = await generateDEK(true)

    const encrypted = await encrypt('wrap test', dek)
    const wrappedDek = await wrapDEK(dek, ak)
    const unwrappedAk = await unwrapAK(
      await wrapAK(ak, ecdh.publicKey, mlkem.publicKey),
      ecdh.privateKey,
      mlkem.secretKey,
    )
    expect(await decrypt(encrypted, await unwrapDEK(wrappedDek, unwrappedAk))).toBe('wrap test')
  })

  it('produces different wrapped values for the same key pair (ephemeral key)', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const ak = await generateAK(true)
    expect(await wrapAK(ak, ecdh.publicKey, mlkem.publicKey)).not.toBe(
      await wrapAK(ak, ecdh.publicKey, mlkem.publicKey),
    )
  })

  it('produces the unchanged v1 envelope byte layout and version (1194 bytes, 0x01)', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const wrapped = await wrapAK(await generateAK(true), ecdh.publicKey, mlkem.publicKey)

    expect(wrapped.length).toBe(1592) // base64 of 1194 bytes
    const envelope = base64ToUint8Array(wrapped)
    expect(envelope.length).toBe(1194)
    expect(envelope[0]).toBe(0x01)
  })
})

describe('rewrapAK', () => {
  it('rewrapped AK unwraps a DEK wrapped with the original', async () => {
    const ecdh1 = await generateKeyPair()
    const mlkem1 = generateMlKemKeyPair()
    const ecdh2 = await generateKeyPair()
    const mlkem2 = generateMlKemKeyPair()
    const ak = await generateAK(true)
    const dek = await generateDEK(true)

    const encrypted = await encrypt('rewrap test', dek)
    const wrappedDek = await wrapDEK(dek, ak)
    const wrappedAk = await wrapAK(ak, ecdh1.publicKey, mlkem1.publicKey)
    const rewrapped = await rewrapAK(wrappedAk, ecdh1.privateKey, mlkem1.secretKey, ecdh2.publicKey, mlkem2.publicKey)
    const unwrappedAk = await unwrapAK(rewrapped, ecdh2.privateKey, mlkem2.secretKey)
    expect(await decrypt(encrypted, await unwrapDEK(wrappedDek, unwrappedAk))).toBe('rewrap test')
  })
})

describe('rewrapKeyring (AK rotation)', () => {
  it('re-wraps a 2-DEK keyring under a new AK, preserving key_ids and decryptability', async () => {
    const oldAK = await generateAK()
    const newAK = await generateAK()

    const { dek: dek0, wrappedKey: wrapped0 } = await mintDEK(oldAK)
    const { dek: dek1, wrappedKey: wrapped1 } = await mintDEK(oldAK)
    const value0 = await encrypt('value under key 0', dek0)
    const value1 = await encrypt('value under key 1', dek1)

    const rewrapped = await rewrapKeyring(
      [
        { keyId: '0', wrappedKey: wrapped0 },
        { keyId: 'v1', wrappedKey: wrapped1 },
      ],
      oldAK,
      newAK,
    )

    expect(rewrapped.map((e) => e.keyId).sort()).toEqual(['0', 'v1'])
    const byId = Object.fromEntries(rewrapped.map((e) => [e.keyId, e.wrappedKey]))

    // Old AK can no longer unwrap the new blobs; new AK can.
    await expect(unwrapDEK(byId['0'], oldAK)).rejects.toThrow('Failed to unwrap DEK')
    expect(await decrypt(value0, await unwrapDEK(byId['0'], newAK))).toBe('value under key 0')
    expect(await decrypt(value1, await unwrapDEK(byId['v1'], newAK))).toBe('value under key 1')
  })
})

describe('unwrapLegacyCK (WS3 absorption)', () => {
  it('unwraps a byte-identical v1 envelope into an extractable AES-GCM CK that decrypts a v1 value', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()

    // A v1 CK is an extractable AES-GCM key; wrapping its raw bytes with the
    // hybrid envelope (via wrapAK) reproduces the byte-identical v1 envelope.
    const legacyCK = await generateDEK(true)
    const v1Value = await encrypt('legacy v1 secret', legacyCK) // v1 wrote with NO AAD
    const envelope = await wrapAK(legacyCK, ecdh.publicKey, mlkem.publicKey)

    const recovered = await unwrapLegacyCK(envelope, ecdh.privateKey, mlkem.secretKey)
    expect(recovered.algorithm.name).toBe('AES-GCM')
    expect(recovered.extractable).toBe(true)
    expect([...recovered.usages].sort()).toEqual(['decrypt', 'encrypt'])
    expect(await decrypt(v1Value, recovered)).toBe('legacy v1 secret')
  })

  it('fails to unwrap with the wrong device keys', async () => {
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    const wrongEcdh = await generateKeyPair()
    const wrongMlkem = generateMlKemKeyPair()
    const envelope = await wrapAK(await generateDEK(true), ecdh.publicKey, mlkem.publicKey)
    await expect(unwrapLegacyCK(envelope, wrongEcdh.privateKey, wrongMlkem.secretKey)).rejects.toThrow(
      'Failed to unwrap legacy content key',
    )
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips plaintext', async () => {
    const dek = await generateDEK()
    const encrypted = await encrypt('Hello, encryption!', dek)
    expect(await decrypt(encrypted, dek)).toBe('Hello, encryption!')
  })

  it('produces different ciphertext for the same plaintext (unique IV)', async () => {
    const dek = await generateDEK()
    const e1 = await encrypt('Same text', dek)
    const e2 = await encrypt('Same text', dek)
    expect(e1.ciphertext).not.toBe(e2.ciphertext)
  })

  it('fails to decrypt with a different key', async () => {
    const encrypted = await encrypt('secret', await generateDEK())
    await expect(decrypt(encrypted, await generateDEK())).rejects.toThrow('Failed to decrypt')
  })

  it('round-trips with additionalData (AAD)', async () => {
    const dek = await generateDEK()
    const aad = new TextEncoder().encode('tablecolumnrow-10')
    const encrypted = await encrypt('aad-bound', dek, aad)
    expect(await decrypt(encrypted, dek, aad)).toBe('aad-bound')
  })

  it('fails to decrypt without AAD when encrypted with AAD (and vice versa)', async () => {
    const dek = await generateDEK()
    const aad = new TextEncoder().encode('some-aad')
    await expect(decrypt(await encrypt('one', dek, aad), dek)).rejects.toThrow('Failed to decrypt')
    await expect(decrypt(await encrypt('two', dek), dek, aad)).rejects.toThrow('Failed to decrypt')
  })
})

describe('encryptBytes / decryptBytes', () => {
  it('round-trips raw bytes', async () => {
    const key = await generateDEK()
    const data = crypto.getRandomValues(new Uint8Array(100))
    const encrypted = await encryptBytes(data, key)
    expect(encrypted.iv.length).toBe(12)
    expect(encrypted.ciphertext).not.toEqual(data)
    expect(await decryptBytes(encrypted, key)).toEqual(data)
  })

  it('fails with a different key', async () => {
    const encrypted = await encryptBytes(new Uint8Array([1, 2, 3]), await generateDEK())
    await expect(decryptBytes(encrypted, await generateDEK())).rejects.toThrow('Failed to decrypt bytes')
  })
})

describe('deriveMlKemAtRestKey', () => {
  it('derives the same key from the same ECDH pair (deterministic self-ECDH)', async () => {
    const keyPair = await generateKeyPair()
    const key1 = await deriveMlKemAtRestKey(keyPair.publicKey, keyPair.privateKey)
    const key2 = await deriveMlKemAtRestKey(keyPair.publicKey, keyPair.privateKey)
    expect(await decryptBytes(await encryptBytes(new Uint8Array([9, 8, 7]), key1), key2)).toEqual(
      new Uint8Array([9, 8, 7]),
    )
  })

  it('derives different keys for different ECDH pairs (sk unreadable without self-ECDH)', async () => {
    const keyPair1 = await generateKeyPair()
    const keyPair2 = await generateKeyPair()
    const key1 = await deriveMlKemAtRestKey(keyPair1.publicKey, keyPair1.privateKey)
    const key2 = await deriveMlKemAtRestKey(keyPair2.publicKey, keyPair2.privateKey)
    await expect(decryptBytes(await encryptBytes(new Uint8Array([1, 2, 3]), key1), key2)).rejects.toThrow(
      'Failed to decrypt bytes',
    )
  })
})
