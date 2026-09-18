/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { getDb } from '@/db/database'
import { setActiveLocale } from '@/i18n/active-locale'
import { settingsTable } from '@/db/tables'
import { hashSetting, type Setting } from '@/defaults/settings'
import { createTestProvider } from '@/test-utils/test-provider'
import { eq } from 'drizzle-orm'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { regionForUnitDefaults, useUnitDefaults } from './use-unit-defaults'

let restoreBrowserLanguages: (() => void) | null = null

/** See the same helper in `use-app-language.test.tsx` — `navigator` is a shared
 *  happy-dom global, so the restore belongs in `afterEach`, not after the
 *  assertions where a failure would skip it. */
const stubBrowserLanguages = (languages: readonly string[]) => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'languages')
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true })
  restoreBrowserLanguages = () => {
    if (original) {
      Object.defineProperty(navigator, 'languages', original)
      return
    }
    delete (navigator as unknown as Record<string, unknown>).languages
  }
}

const renderHookUnderTest = () => renderHook(() => useUnitDefaults(), { wrapper: createTestProvider() })

/**
 * Read the row straight from the database rather than through `useSettings`.
 * The PowerSync test mock never re-emits a watched query, so a reader mounted
 * beside the hook keeps reporting the pre-seed value however long we flush.
 */
const readSetting = async (key: string): Promise<Setting | null> => {
  const rows = await getDb().select().from(settingsTable).where(eq(settingsTable.key, key))
  return (rows[0] as Setting | undefined) ?? null
}

const readValue = async (key: string): Promise<string | null> => (await readSetting(key))?.value ?? null

const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

/**
 * Every test starts from reconciled defaults. `resetTestDatabase` deliberately
 * skips reconciliation, and the difference is not cosmetic: an unreconciled row
 * has no `defaultHash`, which makes `isSettingModified` report false for a value
 * the user did set. Seeding decisions would then depend on test order.
 */
beforeEach(async () => {
  await resetTestDatabase()
  await reconcileDefaults(getDb())
})

afterEach(() => {
  restoreBrowserLanguages?.()
  restoreBrowserLanguages = null
  setActiveLocale('en')
})

describe('regionForUnitDefaults', () => {
  // `navigator.languages` is not guaranteed well-formed; a throw here would escape
  // the seeding effect and take down the tree rather than fall back.
  it('skips malformed browser tags instead of throwing', () => {
    expect(regionForUnitDefaults(null, ['en_US', 'zh-CN-#Hans', 'fr-FR'], 'en')).toBe('FR')
    expect(regionForUnitDefaults(null, ['en_US'], 'en')).toBe('US')
  })

  it('prefers the stored country code', () => {
    expect(regionForUnitDefaults('BR', ['de-DE'], 'de')).toBe('BR')
  })

  it('falls back to the first browser tag carrying a region', () => {
    // `en` alone says nothing about region; `en-GB` does. Skipping the bare tag
    // is what separates a British user from the app's `en` catalog defaulting
    // them to US units.
    expect(regionForUnitDefaults(null, ['en', 'en-GB'], 'en')).toBe('GB')
  })

  it('falls back to the app locale when no browser tag has a region', () => {
    expect(regionForUnitDefaults(null, ['pt'], 'pt-BR')).toBe('BR')
    expect(regionForUnitDefaults(null, [], 'ja')).toBe('JP')
  })

  it('treats an empty stored code as absent', () => {
    expect(regionForUnitDefaults('', ['de-DE'], 'en')).toBe('DE')
  })

  it('lands on US when nothing resolves', () => {
    expect(regionForUnitDefaults(null, [], 'en')).toBe('US')
  })
})

describe('useUnitDefaults', () => {
  it('seeds every unset unit from the browser region', async () => {
    stubBrowserLanguages(['de-DE'])

    renderHookUnderTest()
    await flush()

    expect(await readValue('distance_unit')).toBe('metric')
    expect(await readValue('temperature_unit')).toBe('c')
    expect(await readValue('time_format')).toBe('24h')
    expect(await readValue('currency')).toBe('EUR')
  })

  it('seeds the mixed case the retired lookup table could not express', async () => {
    // Britain is imperial for road distance and Celsius for weather. The old
    // single `unit` field had no way to say that, and shipped no GB row at all.
    stubBrowserLanguages(['en-GB'])

    renderHookUnderTest()
    await flush()

    expect(await readValue('distance_unit')).toBe('imperial')
    expect(await readValue('temperature_unit')).toBe('c')
    expect(await readValue('time_format')).toBe('24h')
    expect(await readValue('currency')).toBe('GBP')
  })

  it('prefers the stored location country over the browser', async () => {
    stubBrowserLanguages(['en-US'])
    await updateSettings(getDb(), { location_country_code: 'JP' })

    renderHookUnderTest()
    await flush()

    expect(await readValue('currency')).toBe('JPY')
    expect(await readValue('time_format')).toBe('24h')
  })

  it('leaves a value the user already chose and still seeds its siblings', async () => {
    // The gate is per setting, not across the group: an all-or-nothing check
    // would let one hand-picked currency block distance, temperature and time
    // from ever being seeded.
    stubBrowserLanguages(['de-DE'])
    await updateSettings(getDb(), { currency: 'USD' })

    renderHookUnderTest()
    await flush()

    expect(await readValue('currency')).toBe('USD')
    expect(await readValue('distance_unit')).toBe('metric')
    expect(await readValue('temperature_unit')).toBe('c')
    expect(await readValue('time_format')).toBe('24h')
  })

  it('seeds as a default rather than a user edit', async () => {
    // `recomputeHash` is what keeps reconcile's `wouldOverwriteUserValue` guard
    // able to tell a seeded value from a chosen one, and keeps reset meaning
    // "back to auto".
    stubBrowserLanguages(['de-DE'])

    renderHookUnderTest()
    await flush()

    const seeded = await readSetting('distance_unit')
    expect(seeded?.value).toBe('metric')
    expect(seeded?.defaultHash).toBe(hashSetting(seeded!))
  })
})
