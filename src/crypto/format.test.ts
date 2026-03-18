import { describe, expect, test } from 'bun:test'
import { formatRecoveryKeyForDisplay } from './format'

describe('formatRecoveryKeyForDisplay', () => {
  test('formats 64-char hex into groups of 8', () => {
    const hex = 'a'.repeat(64)
    const formatted = formatRecoveryKeyForDisplay(hex)
    expect(formatted).toBe('aaaaaaaa aaaaaaaa aaaaaaaa aaaaaaaa aaaaaaaa aaaaaaaa aaaaaaaa aaaaaaaa')
  })

  test('handles already-formatted input', () => {
    const hex = 'a1b2c3d4 e5f6a7b8'
    const formatted = formatRecoveryKeyForDisplay(hex)
    expect(formatted).toBe('a1b2c3d4 e5f6a7b8')
  })

  test('preserves a realistic recovery key', () => {
    const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const formatted = formatRecoveryKeyForDisplay(hex)
    expect(formatted).toBe('01234567 89abcdef 01234567 89abcdef 01234567 89abcdef 01234567 89abcdef')
  })
})
