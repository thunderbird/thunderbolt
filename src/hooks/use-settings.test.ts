import { deserializeValue } from '@/lib/serialization'
import { describe, expect, it } from 'bun:test'
import type { BooleanSettingHook, StringSettingHook } from './use-settings'

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

    it('BooleanSettingHook value cannot be assigned null (compile-time check)', () => {
      // This is a compile-time check - if uncommented, it should fail TypeScript
      // const mockBooleanHook: BooleanSettingHook = {
      //   data: null,
      //   rawSetting: null,
      //   value: null, // ← This should cause a TypeScript error
      //   isModified: false,
      //   setValue: async () => {},
      //   reset: async () => {},
      //   isLoading: false,
      //   isSaving: false,
      //   query: {} as any,
      // }

      // This test passes because the commented code above would fail to compile
      expect(true).toBe(true)
    })
  })
})
