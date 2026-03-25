import { describe, expect, it } from 'bun:test'
import {
  generateKeyPair,
  generateCK,
  reimportAsNonExtractable,
  exportPublicKey,
  importPublicKey,
  wrapCK,
  rewrapCK,
  unwrapCK,
  encrypt,
  decrypt,
} from './primitives'

describe('generateKeyPair', () => {
  it('generates an RSA-OAEP key pair', async () => {
    const keyPair = await generateKeyPair()
    expect(keyPair.publicKey).toBeDefined()
    expect(keyPair.privateKey).toBeDefined()
    expect(keyPair.publicKey.algorithm.name).toBe('RSA-OAEP')
    expect(keyPair.privateKey.extractable).toBe(false)
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
    expect(imported.algorithm.name).toBe('RSA-OAEP')
  })
})

describe('wrapCK / unwrapCK', () => {
  // CK must be extractable for wrapKey in Bun/Node (strict Web Crypto spec).
  // In browsers, wrapKey works with non-extractable keys too.
  // The first-device flow always wraps an extractable CK before re-importing.

  it('round-trips CK through wrap and unwrap', async () => {
    const keyPair = await generateKeyPair()
    const ck = await generateCK(true) // extractable for wrapping

    const wrapped = await wrapCK(ck, keyPair.publicKey)
    expect(typeof wrapped).toBe('string')

    const unwrapped = await unwrapCK(wrapped, keyPair.privateKey)
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
    expect(unwrapped.extractable).toBe(false)
  })

  it('unwrapped CK can encrypt/decrypt the same data as original', async () => {
    const keyPair = await generateKeyPair()
    const ck = await generateCK(true)

    const encrypted = await encrypt('wrap test', ck)
    const wrapped = await wrapCK(ck, keyPair.publicKey)
    const unwrapped = await unwrapCK(wrapped, keyPair.privateKey)

    const decrypted = await decrypt(encrypted, unwrapped)
    expect(decrypted).toBe('wrap test')
  })

  it('produces different wrapped values for different key pairs', async () => {
    const keyPair1 = await generateKeyPair()
    const keyPair2 = await generateKeyPair()
    const ck = await generateCK(true)

    const wrapped1 = await wrapCK(ck, keyPair1.publicKey)
    const wrapped2 = await wrapCK(ck, keyPair2.publicKey)
    expect(wrapped1).not.toBe(wrapped2)
  })
})

describe('rewrapCK', () => {
  it('rewraps CK from one key pair to another', async () => {
    const keyPair1 = await generateKeyPair()
    const keyPair2 = await generateKeyPair()
    const ck = await generateCK(true)

    // Wrap CK with keyPair1's public key (simulates the envelope on the server)
    const wrapped = await wrapCK(ck, keyPair1.publicKey)

    // Rewrap for keyPair2 (simulates approving a new device)
    const rewrapped = await rewrapCK(wrapped, keyPair1.privateKey, keyPair2.publicKey)
    expect(typeof rewrapped).toBe('string')

    // keyPair2 should be able to unwrap it
    const unwrapped = await unwrapCK(rewrapped, keyPair2.privateKey)
    expect(unwrapped.algorithm.name).toBe('AES-GCM')
  })

  it('rewrapped CK decrypts data encrypted with the original', async () => {
    const keyPair1 = await generateKeyPair()
    const keyPair2 = await generateKeyPair()
    const ck = await generateCK(true)

    const encrypted = await encrypt('rewrap test', ck)
    const wrapped = await wrapCK(ck, keyPair1.publicKey)
    const rewrapped = await rewrapCK(wrapped, keyPair1.privateKey, keyPair2.publicKey)
    const unwrapped = await unwrapCK(rewrapped, keyPair2.privateKey)

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
