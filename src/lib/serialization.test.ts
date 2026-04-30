/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { deserializeValue, inferTypeFromSchema, serializeValue } from './serialization'

describe('serialization', () => {
  describe('inferTypeFromSchema', () => {
    it('should return constructors as-is', () => {
      expect(inferTypeFromSchema(String)).toBe(String)
      expect(inferTypeFromSchema(Boolean)).toBe(Boolean)
      expect(inferTypeFromSchema(Number)).toBe(Number)
    })

    it('should infer String from string default values', () => {
      expect(inferTypeFromSchema('hello')).toBe(String)
      expect(inferTypeFromSchema('')).toBe(String)
      expect(inferTypeFromSchema('default value')).toBe(String)
    })

    it('should infer Boolean from boolean default values', () => {
      expect(inferTypeFromSchema(true)).toBe(Boolean)
      expect(inferTypeFromSchema(false)).toBe(Boolean)
    })

    it('should infer Number from number default values', () => {
      expect(inferTypeFromSchema(42)).toBe(Number)
      expect(inferTypeFromSchema(0)).toBe(Number)
      expect(inferTypeFromSchema(3.14)).toBe(Number)
    })

    it('should return undefined for objects and arrays (use JSON fallback)', () => {
      expect(inferTypeFromSchema({ foo: 'bar' })).toBeUndefined()
      expect(inferTypeFromSchema([1, 2, 3])).toBeUndefined()
      expect(inferTypeFromSchema(null)).toBeUndefined()
    })
  })

  describe('serializeValue', () => {
    it('should serialize null as null', () => {
      expect(serializeValue(null)).toBe(null)
    })

    it('should serialize strings without quotes for cleaner storage', () => {
      expect(serializeValue('hello')).toBe('hello')
      expect(serializeValue('https://example.com')).toBe('https://example.com')
      expect(serializeValue('')).toBe('')
    })

    it('should serialize strings with special characters as-is', () => {
      expect(serializeValue('hello"world')).toBe('hello"world')
      expect(serializeValue('hello\\world')).toBe('hello\\world')
      expect(serializeValue('hello\nworld')).toBe('hello\nworld')
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

    it('should deserialize strings without type hint', () => {
      expect(deserializeValue('hello')).toBe('hello')
      expect(deserializeValue('https://example.com')).toBe('https://example.com')
      expect(deserializeValue('')).toBe('')
    })

    it('should deserialize strings with String type hint', () => {
      expect(deserializeValue('hello', String)).toBe('hello')
      expect(deserializeValue('42', String)).toBe('42') // Stays as string with hint
      expect(deserializeValue('true', String)).toBe('true') // Stays as string with hint
    })

    it('should deserialize booleans without type hint', () => {
      expect(deserializeValue('true')).toBe(true)
      expect(deserializeValue('false')).toBe(false)
    })

    it('should deserialize booleans with Boolean type hint', () => {
      expect(deserializeValue('true', Boolean)).toBe(true)
      expect(deserializeValue('false', Boolean)).toBe(false)
    })

    it('should deserialize numbers without type hint', () => {
      expect(deserializeValue('42')).toBe(42)
      expect(deserializeValue('3.14')).toBe(3.14)
      expect(deserializeValue('0')).toBe(0)
    })

    it('should deserialize numbers with Number type hint', () => {
      expect(deserializeValue('42', Number)).toBe(42)
      expect(deserializeValue('3.14', Number)).toBe(3.14)
      expect(deserializeValue('0', Number)).toBe(0)
    })

    it('should deserialize JSON objects and arrays', () => {
      expect(deserializeValue('{"foo":"bar"}')).toEqual({ foo: 'bar' })
      expect(deserializeValue('[1,2,3]')).toEqual([1, 2, 3])
    })

    it('should handle edge cases gracefully', () => {
      // Invalid JSON should return as string
      expect(deserializeValue('not-json-{{')).toBe('not-json-{{')

      // Partial numbers without type hint should return as string
      expect(deserializeValue('42px')).toBe('42px')

      // With String type hint, any value is returned as-is
      expect(deserializeValue('42px', String)).toBe('42px')
    })
  })

  describe('round-trip safety', () => {
    it('should round-trip simple strings correctly with String type hint', () => {
      const testCases = ['hello', 'world', 'test string', 'https://example.com']

      for (const original of testCases) {
        const serialized = serializeValue(original)
        const deserialized = deserializeValue(serialized, String)
        expect(deserialized).toBe(original)
      }
    })

    it('should round-trip strings with special characters with String type hint', () => {
      const testCases = [
        'hello"world', // Double quote
        "hello'world", // Single quote
        'hello\\world', // Backslash
        'hello\nworld', // Newline
        'hello\tworld', // Tab
        'hello\rworld', // Carriage return
      ]

      for (const original of testCases) {
        const serialized = serializeValue(original)
        const deserialized = deserializeValue(serialized, String)
        expect(deserialized).toBe(original)
      }
    })

    it('should round-trip numbers correctly with Number type hint', () => {
      const testCases = [0, 1, -1, 42, 3.14, -3.14, 0.001]

      for (const original of testCases) {
        const serialized = serializeValue(original)
        const deserialized = deserializeValue(serialized, Number)
        expect(deserialized).toBe(original)
      }
    })

    it('should round-trip booleans correctly with Boolean type hint', () => {
      const testCases = [true, false]

      for (const original of testCases) {
        const serialized = serializeValue(original)
        const deserialized = deserializeValue(serialized, Boolean)
        expect(deserialized).toBe(original)
      }
    })

    it('should round-trip objects correctly', () => {
      const testCases = [{ foo: 'bar' }, { nested: { value: 42 } }, { array: [1, 2, 3] }]

      for (const original of testCases) {
        const serialized = serializeValue(original)
        const deserialized = deserializeValue(serialized)
        expect(deserialized).toEqual(original)
      }
    })

    it('should handle round-trips without type hints (backward compatibility)', () => {
      // Strings that don't look like other types
      expect(deserializeValue(serializeValue('hello'))).toBe('hello')
      // Numbers
      expect(deserializeValue(serializeValue(42))).toBe(42)
      // Booleans
      expect(deserializeValue(serializeValue(true))).toBe(true)
      expect(deserializeValue(serializeValue(false))).toBe(false)
      // Objects
      expect(deserializeValue(serializeValue({ foo: 'bar' }))).toEqual({ foo: 'bar' })
    })
  })
})
