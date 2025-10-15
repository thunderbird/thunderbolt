import { describe, expect, it } from 'bun:test'
import { deserializeValue, serializeValue } from './setting-types'

describe('setting-types', () => {
  describe('serializeValue', () => {
    it('should serialize null as null', () => {
      expect(serializeValue(null)).toBe(null)
    })

    it('should serialize strings without quotes', () => {
      expect(serializeValue('hello')).toBe('hello')
      expect(serializeValue('https://example.com')).toBe('https://example.com')
      expect(serializeValue('')).toBe('')
    })

    it('should serialize booleans as "true" or "false"', () => {
      expect(serializeValue(true)).toBe('true')
      expect(serializeValue(false)).toBe('false')
    })

    it('should serialize numbers as JSON strings', () => {
      expect(serializeValue(42)).toBe('42')
      expect(serializeValue(3.14)).toBe('3.14')
      expect(serializeValue(0)).toBe('0')
    })

    it('should serialize objects as JSON', () => {
      expect(serializeValue({ foo: 'bar' })).toBe('{"foo":"bar"}')
      expect(serializeValue([1, 2, 3])).toBe('[1,2,3]')
    })
  })

  describe('deserializeValue', () => {
    it('should deserialize null and undefined as null', () => {
      expect(deserializeValue(null)).toBe(null)
      expect(deserializeValue(undefined)).toBe(null)
    })

    it('should deserialize unquoted strings as strings', () => {
      expect(deserializeValue('hello')).toBe('hello')
      expect(deserializeValue('https://example.com')).toBe('https://example.com')
      expect(deserializeValue('')).toBe('')
    })

    it('should deserialize "true" and "false" as booleans', () => {
      expect(deserializeValue('true')).toBe(true)
      expect(deserializeValue('false')).toBe(false)
    })

    it('should deserialize number strings as numbers', () => {
      expect(deserializeValue('42')).toBe(42)
      expect(deserializeValue('3.14')).toBe(3.14)
      expect(deserializeValue('0')).toBe(0)
    })

    it('should deserialize JSON objects and arrays', () => {
      expect(deserializeValue('{"foo":"bar"}')).toEqual({ foo: 'bar' })
      expect(deserializeValue('[1,2,3]')).toEqual([1, 2, 3])
    })

    it('should handle edge cases gracefully', () => {
      // Invalid JSON should return as string
      expect(deserializeValue('not-json-{{')).toBe('not-json-{{')

      // Partial numbers should return as string
      expect(deserializeValue('42px')).toBe('42px')
    })
  })
})
