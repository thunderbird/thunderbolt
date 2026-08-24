/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getActiveLocale, setActiveLocale, subscribeActiveLocale } from '@/i18n/active-locale'
import { getClock } from '@/testing-library'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { useAppLanguage } from './use-app-language'
import { useSettings } from './use-settings'

const storageKey = 'thunderbolt_locale'

/** Pose as a browser with the given language preferences; returns a restore fn. */
const stubBrowserLanguages = (languages: readonly string[]) => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'languages')
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true })
  return () => {
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
    const announced: string[] = []
    const unsubscribe = subscribeActiveLocale(() => announced.push(getActiveLocale()))

    const { result } = renderWithSettingReader()

    expect(result.current.language.isLoading).toBe(true)
    expect(announced).not.toContain('en')
    expect(getActiveLocale()).toBe('ja')
    expect(localStorage.getItem(storageKey)).toBe('ja')
    unsubscribe()
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
    const restoreLanguages = stubBrowserLanguages(['de'])
    setActiveLocale('de')
    const announced: string[] = []
    const unsubscribe = subscribeActiveLocale(() => announced.push(getActiveLocale()))

    const { result } = renderWithSettingReader()
    await flush()

    expect(result.current.language.isLoading).toBe(false)
    expect(announced).not.toContain('en')
    expect(getActiveLocale()).toBe('de')
    expect(localStorage.getItem(storageKey)).toBe('de')

    unsubscribe()
    restoreLanguages()
  })

  it('publishes an explicit stored setting over the browser languages', async () => {
    const restoreLanguages = stubBrowserLanguages(['de'])
    await updateSettings(getDb(), { language: 'ja' })

    const { result } = renderWithSettingReader()
    await flush()

    expect(result.current.language.isLoading).toBe(false)
    expect(getActiveLocale()).toBe('ja')
    expect(localStorage.getItem(storageKey)).toBe('ja')

    restoreLanguages()
  })
})
