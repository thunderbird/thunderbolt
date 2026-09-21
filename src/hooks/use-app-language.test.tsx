/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettingsRecords, resetSettingToDefault, updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { defaultSettings } from '@/defaults/settings'
import { getActiveLocale, setActiveLocale, subscribeActiveLocale } from '@/i18n/active-locale'
import { getClock } from '@/testing-library'
import { PowerSyncReactivityTestProvider } from '@/test-utils/powersync-mock'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { useAppLanguage } from './use-app-language'
import { useSettings } from './use-settings'

const storageKey = 'thunderbolt_locale'

let restoreBrowserLanguages: (() => void) | null = null

/**
 * Pose as a browser with the given language preferences. Undone by `afterEach`
 * rather than by the caller: `navigator` is a happy-dom global shared by every
 * test in the run, so a restore placed after the assertions would be skipped on
 * failure and leave later files negotiating against the stub.
 */
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

/**
 * Mount the hook alongside a reader of the same setting, so a test can tell
 * hydration apart from a query still in flight.
 *
 * The settings row has to be seeded *before* mounting: the PowerSync test mock's
 * `onChangeWithCallback` is a no-op, so a watched query never re-emits after a
 * write, and post-mount changes are invisible to the hook.
 */
const renderWithSettingReader = () =>
  renderHook(
    () => {
      useAppLanguage()
      return useSettings({ language: 'en' })
    },
    { wrapper: createTestProvider() },
  )

/**
 * Same hook pair, but over the reactive PowerSync mock, whose `triggerChange`
 * makes the watched settings query re-emit — the stand-in for a synced write
 * arriving from another device. This is the only way to exercise anything
 * post-mount at the unit layer; with the default no-op mock (above) a written
 * row stays invisible forever.
 */
const renderWithLiveSettings = () => {
  const triggerChangeRef = { current: null as ((tables: string[]) => void) | null }
  const rendered = renderHook(
    () => {
      useAppLanguage()
      return useSettings({ language: 'en' })
    },
    {
      wrapper: ({ children }) => (
        <PowerSyncReactivityTestProvider tables={['settings']} triggerChangeRef={triggerChangeRef}>
          {children}
        </PowerSyncReactivityTestProvider>
      ),
    },
  )
  const settingsChanged = () => triggerChangeRef.current?.(['settings'])
  return { ...rendered, settingsChanged }
}

const storedLanguage = async (): Promise<string | null> => {
  const [record] = await getSettingsRecords(getDb(), ['language'])
  return record?.value ?? null
}

const languageDefault = defaultSettings.find((setting) => setting.key === 'language')
if (!languageDefault) {
  throw new Error('language default missing from defaultSettings')
}

let unsubscribeAnnouncements: (() => void) | null = null

/** Collect every locale announced from now until `afterEach` tears the listener down. */
const recordAnnouncements = (): string[] => {
  const announced: string[] = []
  unsubscribeAnnouncements = subscribeActiveLocale(() => announced.push(getActiveLocale()))
  return announced
}

/** Drain the settings query and every effect it schedules (global fake clock). */
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

afterEach(async () => {
  await resetTestDatabase()
  restoreBrowserLanguages?.()
  restoreBrowserLanguages = null
  unsubscribeAnnouncements?.()
  unsubscribeAnnouncements = null
  setActiveLocale('en')
  localStorage.removeItem(storageKey)
})

describe('useAppLanguage', () => {
  /**
   * `useSettings` reports the schema fallback (`en`) until the settings row
   * arrives, so publishing on every render announced `en` on each page load —
   * overwriting the boot-seeded locale and its localStorage mirror, and sending
   * `X-App-Language: en` on every request that beat hydration. Asserted
   * immediately after mount, while the query is still in flight.
   */
  it('does not announce the fallback locale while the setting is loading', () => {
    setActiveLocale('ja')
    const announced = recordAnnouncements()

    const { result } = renderWithSettingReader()

    expect(result.current.language.isLoading).toBe(true)
    expect(announced).not.toContain('en')
    expect(getActiveLocale()).toBe('ja')
    expect(localStorage.getItem(storageKey)).toBe('ja')
  })

  /**
   * A first-ever session on a non-English browser: no mirror, and a row that
   * exists but holds null. Boot negotiates `de`; reading that null through the
   * hook's schema fallback made it indistinguishable from an explicit `en`, so
   * the effect published `en` — and mirrored it — until the async seed write
   * flipped it back. The window is brief, but the mirror write outlives it, so a
   * reload inside it would start from `en` instead of negotiating.
   */
  it('keeps the negotiated locale when the stored setting is merely unset', async () => {
    stubBrowserLanguages(['de'])
    setActiveLocale('de')
    const announced = recordAnnouncements()

    const { result } = renderWithSettingReader()
    await flush()

    expect(result.current.language.isLoading).toBe(false)
    expect(announced).not.toContain('en')
    expect(getActiveLocale()).toBe('de')
    expect(localStorage.getItem(storageKey)).toBe('de')
  })

  it('publishes an explicit stored setting over the browser languages', async () => {
    stubBrowserLanguages(['de'])
    await updateSettings(getDb(), { language: 'ja' })

    const { result } = renderWithSettingReader()
    await flush()

    expect(result.current.language.isLoading).toBe(false)
    expect(getActiveLocale()).toBe('ja')
    expect(localStorage.getItem(storageKey)).toBe('ja')
  })

  /**
   * A language change synced in from another device, arriving after mount: the
   * watched query re-emits, and the hook must publish the new locale and
   * refresh the mirror without a reload. This was untestable before the
   * reactive mock — the THU-808 bugs in exactly this seam were all found by
   * hand.
   */
  it('follows a cross-device language change arriving after mount', async () => {
    stubBrowserLanguages(['en-US'])
    await updateSettings(getDb(), { language: 'de' })
    setActiveLocale('de')

    const { settingsChanged } = renderWithLiveSettings()
    await flush()
    expect(getActiveLocale()).toBe('de')

    await updateSettings(getDb(), { language: 'ja' })
    settingsChanged()
    await flush()

    expect(getActiveLocale()).toBe('ja')
    expect(localStorage.getItem(storageKey)).toBe('ja')
  })

  /**
   * "Back to auto" arriving from another device: the row returns to the shipped
   * null default, so this device renegotiates from its own browser — and, since
   * its negotiation is non-English, re-seeds the row with it.
   */
  it('renegotiates and re-seeds when a reset arrives from another device', async () => {
    stubBrowserLanguages(['de'])
    await updateSettings(getDb(), { language: 'ja' })
    setActiveLocale('ja')

    const { settingsChanged } = renderWithLiveSettings()
    await flush()
    expect(getActiveLocale()).toBe('ja')

    await resetSettingToDefault(getDb(), 'language', languageDefault)
    settingsChanged()
    await flush()

    expect(getActiveLocale()).toBe('de')
    expect(localStorage.getItem(storageKey)).toBe('de')
    expect(await storedLanguage()).toBe('de')
  })
})
