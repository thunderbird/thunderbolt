import { describe, expect, it } from 'bun:test'
import { isValidBase64, decodeIfValidBase64, encodeToBase64 } from './base64'

describe('base64 utilities', () => {
  describe('isValidBase64', () => {
    it('returns true for valid base64', () => {
      expect(isValidBase64(btoa('hello'))).toBe(true)
    })

    it('returns false for non-base64 strings', () => {
      expect(isValidBase64('not base64!!!')).toBe(false)
    })

    it('returns false for empty strings', () => {
      expect(isValidBase64('')).toBe(false)
    })
  })

  describe('encodeToBase64', () => {
    it('encodes to base64', () => {
      expect(encodeToBase64('hello')).toBe(btoa('hello'))
    })
  })

  describe('decodeIfValidBase64', () => {
    it('decodes valid base64', () => {
      const encoded = btoa('hello world')
      expect(decodeIfValidBase64(encoded)).toBe('hello world')
    })

    it('returns original for non-base64', () => {
      expect(decodeIfValidBase64('not base64!!!')).toBe('not base64!!!')
    })

    it('returns empty string as-is', () => {
      expect(decodeIfValidBase64('')).toBe('')
    })
  })

  describe('round-trip', () => {
    it('encode → decode returns original', () => {
      const cases = ['hello', 'hello world', '{"key": "value"}', 'a']
      for (const original of cases) {
        const encoded = encodeToBase64(original)
        const decoded = decodeIfValidBase64(encoded)
        expect(decoded).toBe(original)
      }
    })
  })
})
