import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DecryptionError, EncryptionError } from './errors'
import { decryptRecord, encryptRecord } from './envelope'
import { _clearCache, setMasterKey } from './master-key'
import { exportKeyBytes, generateMasterKey } from './primitives'

describe('envelope encryption', () => {
  beforeEach(async () => {
    localStorage.clear()
    _clearCache()
    const key = await generateMasterKey()
    await setMasterKey(await exportKeyBytes(key))
  })

  afterEach(() => {
    localStorage.clear()
    _clearCache()
  })

  test('encryptRecord + decryptRecord round-trip', async () => {
    const plaintext = 'hello world, this is sensitive data!'
    const record = await encryptRecord(plaintext)
    const decrypted = await decryptRecord(record)
    expect(decrypted).toBe(plaintext)
  })

  test('produces different iv and ciphertext for same plaintext', async () => {
    const plaintext = 'same message'
    const record1 = await encryptRecord(plaintext)
    const record2 = await encryptRecord(plaintext)
    expect(record1.iv).not.toBe(record2.iv)
    expect(record1.ciphertext).not.toBe(record2.ciphertext)
    expect(record1.wrappedContentKey).not.toBe(record2.wrappedContentKey)
  })

  test('record has correct version', async () => {
    const record = await encryptRecord('test')
    expect(record.version).toBe('v1')
  })

  test('decryptRecord with tampered ciphertext throws DecryptionError', async () => {
    const record = await encryptRecord('sensitive')
    const tampered = { ...record, ciphertext: 'AAAA' + record.ciphertext.slice(4) }
    await expect(decryptRecord(tampered)).rejects.toThrow(DecryptionError)
  })

  test('decryptRecord with tampered wrappedContentKey throws DecryptionError', async () => {
    const record = await encryptRecord('sensitive')
    const tampered = { ...record, wrappedContentKey: 'AAAA' + record.wrappedContentKey.slice(4) }
    await expect(decryptRecord(tampered)).rejects.toThrow(DecryptionError)
  })

  test('encryptRecord throws EncryptionError when no master key', async () => {
    localStorage.clear()
    _clearCache()
    await expect(encryptRecord('test')).rejects.toThrow(EncryptionError)
  })

  test('decryptRecord throws EncryptionError when no master key', async () => {
    const record = await encryptRecord('test')
    localStorage.clear()
    _clearCache()
    await expect(decryptRecord(record)).rejects.toThrow(EncryptionError)
  })

  test('handles unicode and emoji', async () => {
    const plaintext = '日本語テスト 🔐🔑 café'
    const record = await encryptRecord(plaintext)
    expect(await decryptRecord(record)).toBe(plaintext)
  })

  test('handles empty string', async () => {
    const record = await encryptRecord('')
    expect(await decryptRecord(record)).toBe('')
  })

  test('record is JSON-serialisable', async () => {
    const record = await encryptRecord('test data')
    const json = JSON.stringify(record)
    const parsed = JSON.parse(json)
    expect(await decryptRecord(parsed)).toBe('test data')
  })
})
