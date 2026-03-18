import { describe, expect, test } from 'bun:test'
import {
  decrypt,
  encrypt,
  exportKeyBytes,
  generateContentKey,
  generateMasterKey,
  importKeyBytes,
  unwrapContentKey,
  wrapContentKey,
} from './primitives'

describe('generateMasterKey', () => {
  test('generates an extractable AES-GCM 256-bit key', async () => {
    const key = await generateMasterKey()
    expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect(key.extractable).toBe(true)
    expect(key.usages).toContain('encrypt')
    expect(key.usages).toContain('wrapKey')
  })
})

describe('generateContentKey', () => {
  test('generates an extractable AES-GCM 256-bit key', async () => {
    const key = await generateContentKey()
    expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect(key.extractable).toBe(true)
  })
})

describe('encrypt / decrypt', () => {
  test('round-trip returns original plaintext', async () => {
    const key = await generateContentKey()
    const plaintext = new TextEncoder().encode('hello world')
    const { iv, ciphertext } = await encrypt(key, plaintext)
    const decrypted = await decrypt(key, iv, ciphertext)
    expect(decrypted).toEqual(plaintext)
  })

  test('produces different IVs and ciphertexts for same plaintext', async () => {
    const key = await generateContentKey()
    const plaintext = new TextEncoder().encode('same message')
    const result1 = await encrypt(key, plaintext)
    const result2 = await encrypt(key, plaintext)
    expect(result1.iv).not.toEqual(result2.iv)
    expect(result1.ciphertext).not.toEqual(result2.ciphertext)
  })

  test('decrypt with tampered ciphertext throws', async () => {
    const key = await generateContentKey()
    const plaintext = new TextEncoder().encode('sensitive data')
    const { iv, ciphertext } = await encrypt(key, plaintext)

    // Tamper with ciphertext
    const tampered = new Uint8Array(ciphertext)
    tampered[0] ^= 0xff

    await expect(decrypt(key, iv, tampered)).rejects.toThrow()
  })

  test('decrypt with wrong key throws', async () => {
    const key1 = await generateContentKey()
    const key2 = await generateContentKey()
    const plaintext = new TextEncoder().encode('secret')
    const { iv, ciphertext } = await encrypt(key1, plaintext)

    await expect(decrypt(key2, iv, ciphertext)).rejects.toThrow()
  })
})

describe('wrapContentKey / unwrapContentKey', () => {
  test('round-trip returns a functionally equivalent key', async () => {
    const masterKey = await generateMasterKey()
    const contentKey = await generateContentKey()

    const wrapped = await wrapContentKey(masterKey, contentKey)
    const unwrapped = await unwrapContentKey(masterKey, wrapped)

    // Verify the unwrapped key works the same as the original
    const plaintext = new TextEncoder().encode('test data')
    const { iv, ciphertext } = await encrypt(contentKey, plaintext)
    const decrypted = await decrypt(unwrapped, iv, ciphertext)
    expect(decrypted).toEqual(plaintext)
  })

  test('unwrap with wrong master key throws', async () => {
    const masterKey1 = await generateMasterKey()
    const masterKey2 = await generateMasterKey()
    const contentKey = await generateContentKey()

    const wrapped = await wrapContentKey(masterKey1, contentKey)
    await expect(unwrapContentKey(masterKey2, wrapped)).rejects.toThrow()
  })
})

describe('exportKeyBytes / importKeyBytes', () => {
  test('round-trip preserves key', async () => {
    const original = await generateMasterKey()
    const bytes = await exportKeyBytes(original)
    expect(bytes.length).toBe(32)

    const imported = await importKeyBytes(bytes, true)
    const reimported = await exportKeyBytes(imported)
    expect(reimported).toEqual(bytes)
  })

  test('extractable flag is respected', async () => {
    const original = await generateMasterKey()
    const bytes = await exportKeyBytes(original)

    const nonExtractable = await importKeyBytes(bytes, false)
    expect(nonExtractable.extractable).toBe(false)

    const extractable = await importKeyBytes(bytes, true)
    expect(extractable.extractable).toBe(true)
  })
})
