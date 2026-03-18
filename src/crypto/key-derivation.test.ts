import { describe, expect, test } from 'bun:test'
import { ValidationError } from './errors'
import { decodeRecoveryKey, deriveKeyFromPassphrase, encodeRecoveryKey, generateSalt } from './key-derivation'
import { exportKeyBytes } from './primitives'

describe('deriveKeyFromPassphrase', () => {
  test('same passphrase and salt produces the same key', async () => {
    const salt = generateSalt()
    const key1 = await deriveKeyFromPassphrase('my passphrase', salt)
    const key2 = await deriveKeyFromPassphrase('my passphrase', salt)

    const bytes1 = await exportKeyBytes(key1)
    const bytes2 = await exportKeyBytes(key2)
    expect(bytes1).toEqual(bytes2)
  })

  test('different salt produces different key', async () => {
    const salt1 = generateSalt()
    const salt2 = generateSalt()
    const key1 = await deriveKeyFromPassphrase('same passphrase', salt1)
    const key2 = await deriveKeyFromPassphrase('same passphrase', salt2)

    const bytes1 = await exportKeyBytes(key1)
    const bytes2 = await exportKeyBytes(key2)
    expect(bytes1).not.toEqual(bytes2)
  })

  test('different passphrase produces different key', async () => {
    const salt = generateSalt()
    const key1 = await deriveKeyFromPassphrase('passphrase one', salt)
    const key2 = await deriveKeyFromPassphrase('passphrase two', salt)

    const bytes1 = await exportKeyBytes(key1)
    const bytes2 = await exportKeyBytes(key2)
    expect(bytes1).not.toEqual(bytes2)
  })

  test('derived key is extractable with correct usages', async () => {
    const salt = generateSalt()
    const key = await deriveKeyFromPassphrase('test', salt)
    expect(key.extractable).toBe(true)
    expect(key.usages).toContain('encrypt')
    expect(key.usages).toContain('wrapKey')
  })
})

describe('generateSalt', () => {
  test('generates 16 bytes', () => {
    const salt = generateSalt()
    expect(salt.length).toBe(16)
  })

  test('generates different values', () => {
    const salt1 = generateSalt()
    const salt2 = generateSalt()
    expect(salt1).not.toEqual(salt2)
  })
})

describe('encodeRecoveryKey / decodeRecoveryKey', () => {
  test('round-trip preserves bytes', () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32))
    const hex = encodeRecoveryKey(keyBytes)
    expect(hex.length).toBe(64)
    expect(decodeRecoveryKey(hex)).toEqual(keyBytes)
  })

  test('produces lowercase hex', () => {
    const hex = encodeRecoveryKey(new Uint8Array(32))
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })

  test('decodeRecoveryKey strips whitespace', () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32))
    const hex = encodeRecoveryKey(keyBytes)
    const withSpaces = hex.match(/.{8}/g)!.join(' ')
    expect(decodeRecoveryKey(withSpaces)).toEqual(keyBytes)
  })

  test('decodeRecoveryKey throws ValidationError for wrong length', () => {
    expect(() => decodeRecoveryKey('abcd')).toThrow(ValidationError)
  })

  test('decodeRecoveryKey throws ValidationError for non-hex chars', () => {
    const invalid = 'g'.repeat(64)
    expect(() => decodeRecoveryKey(invalid)).toThrow(ValidationError)
  })

  test('decodeRecoveryKey throws ValidationError for empty string', () => {
    expect(() => decodeRecoveryKey('')).toThrow(ValidationError)
  })
})
