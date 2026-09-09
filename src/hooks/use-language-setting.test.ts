/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettingsRecords, updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { setActiveLocale } from '@/i18n/active-locale'
import { getClock } from '@/testing-library'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { useLanguageSetting } from './use-language-setting'

const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

const storedValue = async (key: string) => {
  const [record] = await getSettingsRecords(getDb(), [key])
  return record?.value ?? null
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(async () => {
  await resetTestDatabase()
  setActiveLocale('en')
  localStorage.removeItem('thunderbolt_locale')
})

/**
 * The rows have to exist before mounting — the PowerSync test mock never
 * re-emits a watched query, so the hook cannot see a row written after mount.
 */
const renderLanguageSetting = async () => {
  const rendered = renderHook(() => useLanguageSetting(), { wrapper: createTestProvider() })
  await flush()
  return rendered
}

describe('useLanguageSetting', () => {
  /**
   * The display name is language-specific, so leaving it behind would render
   * the previous language's name against the new UI language until something
   * else happened to rewrite it. Clearing hands the refill to
   * `useLocationNameDisplay`, and reaches the other devices as an invalidation.
   */
  it('clears the location display name when the language changes', async () => {
    await updateSettings(getDb(), { language: 'pt-BR', location_name_display: 'Munique, Baviera, Alemanha' })
    const { result } = await renderLanguageSetting()

    await act(async () => {
      await result.current.setLanguage('ja')
    })

    expect(await storedValue('language')).toBe('ja')
    expect(await storedValue('location_name_display')).toBeNull()
  })

  it('clears it when the language goes back to auto', async () => {
    await updateSettings(getDb(), { language: 'pt-BR', location_name_display: 'Munique, Baviera, Alemanha' })
    const { result } = await renderLanguageSetting()

    await act(async () => {
      await result.current.resetLanguage()
    })

    expect(await storedValue('language')).toBeNull()
    expect(await storedValue('location_name_display')).toBeNull()
  })

  it('still writes the language when there is no display name to clear', async () => {
    const { result } = await renderLanguageSetting()

    await act(async () => {
      await result.current.setLanguage('de')
    })

    expect(await storedValue('language')).toBe('de')
    expect(await storedValue('location_name_display')).toBeNull()
  })
})
