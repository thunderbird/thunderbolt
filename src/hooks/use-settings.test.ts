import { deserializeValue } from '@/lib/serialization'
import { describe, expect, it } from 'bun:test'
import type { BooleanSettingHook, StringSettingHook } from './use-settings'
import { shouldInvalidateSettingsSubset } from './use-settings'

/**
 * Tests for type safety guarantees of useSettings hook
 * These tests verify that the hook properly handles type safety,
 * particularly for boolean settings that should never return null
 */
describe('useSettings type safety', () => {
  describe('deserializeValue behavior', () => {
    it('should return null for undefined/null values', () => {
      expect(deserializeValue(undefined)).toBe(null)
      expect(deserializeValue(null)).toBe(null)
    })

    it('should deserialize boolean strings correctly', () => {
      expect(deserializeValue('true')).toBe(true)
      expect(deserializeValue('false')).toBe(false)
    })
  })

  describe('nullish coalescing with false default', () => {
    it('should return false when deserializedValue is null and default is false', () => {
      const deserializedValue = null
      const defaultValue = false
      const value = deserializedValue ?? defaultValue

      expect(value).toBe(false)
      expect(typeof value).toBe('boolean')
    })

    it('should return the deserialized boolean when not null', () => {
      const deserializedValue = true
      const defaultValue = false
      const value = deserializedValue ?? defaultValue

      expect(value).toBe(true)
      expect(typeof value).toBe('boolean')
    })
  })

  describe('type inference for hooks', () => {
    it('BooleanSettingHook should enforce boolean type (not boolean | null)', () => {
      // This test verifies type safety at compile time
      // If the type definition is wrong, TypeScript will error on these lines
      const mockBooleanHook: BooleanSettingHook = {
        data: null,
        rawSetting: null,
        value: false, // Must be boolean, not null
        isModified: false,
        setValue: async () => {},
        reset: async () => {},
        isLoading: false,
        isSaving: false,
        query: {} as any,
      }

      // TypeScript enforces this is boolean
      const val: boolean = mockBooleanHook.value
      expect(typeof val).toBe('boolean')
    })

    it('StringSettingHook should allow string | null', () => {
      // This test verifies type safety at compile time
      const mockStringHook: StringSettingHook = {
        data: null,
        rawSetting: null,
        value: null, // Can be null
        isModified: false,
        setValue: async () => {},
        reset: async () => {},
        isLoading: false,
        isSaving: false,
        query: {} as any,
      }

      // TypeScript enforces this is string | null
      const val: string | null = mockStringHook.value
      expect(val).toBe(null)
    })
  })
})

describe('shouldInvalidateSettingsSubset', () => {
  it('should return true when query is a settings query and key is in subset', () => {
    const query = { queryKey: ['settings', 'a', 'b', 'c'] as const }
    expect(shouldInvalidateSettingsSubset(query, 'a')).toBe(true)
    expect(shouldInvalidateSettingsSubset(query, 'b')).toBe(true)
    expect(shouldInvalidateSettingsSubset(query, 'c')).toBe(true)
  })

  it('should return false when query is a settings query but key is not in subset', () => {
    const query = { queryKey: ['settings', 'a', 'b'] as const }
    expect(shouldInvalidateSettingsSubset(query, 'c')).toBe(false)
    expect(shouldInvalidateSettingsSubset(query, 'd')).toBe(false)
  })

  it('should return false for non-settings queries', () => {
    const query1 = { queryKey: ['users', '123'] as const }
    const query2 = { queryKey: ['posts'] as const }
    const query3 = { queryKey: ['other', 'a', 'b'] as const }

    expect(shouldInvalidateSettingsSubset(query1, 'a')).toBe(false)
    expect(shouldInvalidateSettingsSubset(query2, 'a')).toBe(false)
    expect(shouldInvalidateSettingsSubset(query3, 'a')).toBe(false)
  })

  it('should return false when queryKey is not an array', () => {
    const query1 = { queryKey: 'settings' as any }
    const query2 = { queryKey: null as any }
    const query3 = { queryKey: undefined as any }

    expect(shouldInvalidateSettingsSubset(query1, 'a')).toBe(false)
    expect(shouldInvalidateSettingsSubset(query2, 'a')).toBe(false)
    expect(shouldInvalidateSettingsSubset(query3, 'a')).toBe(false)
  })

  it('should return false when queryKey is an empty array', () => {
    const query = { queryKey: [] as const }
    expect(shouldInvalidateSettingsSubset(query, 'a')).toBe(false)
  })

  it('should return false when settings query has no subset keys', () => {
    const query = { queryKey: ['settings'] as const }
    expect(shouldInvalidateSettingsSubset(query, 'a')).toBe(false)
  })

  it('should handle single key in subset', () => {
    const query = { queryKey: ['settings', 'single_key'] as const }
    expect(shouldInvalidateSettingsSubset(query, 'single_key')).toBe(true)
    expect(shouldInvalidateSettingsSubset(query, 'other_key')).toBe(false)
  })

  it('should handle multiple keys in subset correctly', () => {
    const query = { queryKey: ['settings', 'key1', 'key2', 'key3'] as const }
    expect(shouldInvalidateSettingsSubset(query, 'key1')).toBe(true)
    expect(shouldInvalidateSettingsSubset(query, 'key2')).toBe(true)
    expect(shouldInvalidateSettingsSubset(query, 'key3')).toBe(true)
    expect(shouldInvalidateSettingsSubset(query, 'key4')).toBe(false)
  })

  it('should be case-sensitive for key matching', () => {
    const query = { queryKey: ['settings', 'KeyName'] as const }
    expect(shouldInvalidateSettingsSubset(query, 'KeyName')).toBe(true)
    expect(shouldInvalidateSettingsSubset(query, 'keyname')).toBe(false)
    expect(shouldInvalidateSettingsSubset(query, 'KEYNAME')).toBe(false)
  })
})
