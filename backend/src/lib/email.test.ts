import { describe, expect, it } from 'bun:test'
import { normalizeEmail } from './email'

describe('normalizeEmail', () => {
  it('should convert email to lowercase', () => {
    expect(normalizeEmail('TEST@EXAMPLE.COM')).toBe('test@example.com')
    expect(normalizeEmail('John.Doe@Gmail.COM')).toBe('john.doe@gmail.com')
  })

  it('should trim whitespace', () => {
    expect(normalizeEmail('  test@example.com  ')).toBe('test@example.com')
    expect(normalizeEmail('\ttest@example.com\n')).toBe('test@example.com')
  })

  it('should handle both lowercase and trim together', () => {
    expect(normalizeEmail('  TEST@EXAMPLE.COM  ')).toBe('test@example.com')
  })

  it('should return already normalized email unchanged', () => {
    expect(normalizeEmail('test@example.com')).toBe('test@example.com')
  })
})
