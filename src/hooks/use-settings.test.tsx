/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { deserializeValue } from '@/lib/serialization'
import type { BooleanSettingHook, StringSettingHook } from './use-settings'
import { useSettings } from './use-settings'

const TestSettingsComponent = () => {
  const { testKey } = useSettings({ test_key: String })
  return <span data-testid="setting-value">{testKey.value ?? 'null'}</span>
}

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
        query: {} as BooleanSettingHook['query'],
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
        query: {} as StringSettingHook['query'],
      }

      // TypeScript enforces this is string | null
      const val: string | null = mockStringHook.value
      expect(val).toBe(null)
    })
  })
})

describe('useSettings reactivity', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('updates when settings table changes', async () => {
    const db = getDb()
    await updateSettings(db, { test_key: 'initial' })

    const { triggerChange } = renderWithReactivity(<TestSettingsComponent />, {
      tables: ['settings'],
    })

    await waitForElement(() =>
      screen.queryByTestId('setting-value')?.textContent === 'initial' ? screen.getByTestId('setting-value') : null,
    )
    expect(screen.getByTestId('setting-value').textContent).toBe('initial')

    await updateSettings(db, { test_key: 'updated' })
    triggerChange(['settings'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByTestId('setting-value').textContent).toBe('updated')
  })
})
