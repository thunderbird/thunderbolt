/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getActiveLocale, setActiveLocale, subscribeActiveLocale } from '@/i18n/active-locale'
import { createTestProvider } from '@/test-utils/test-provider'
import { renderHook, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { useAppLanguage } from './use-app-language'

const storageKey = 'thunderbolt_locale'

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
   * `X-App-Language: en` on every request that beat hydration. The locale a
   * previous session settled on has to survive the query being in flight.
   */
  it('does not announce the fallback locale while the setting is loading', async () => {
    setActiveLocale('ja')
    const announced: string[] = []
    const unsubscribe = subscribeActiveLocale(() => announced.push(getActiveLocale()))

    renderHook(() => useAppLanguage(), { wrapper: createTestProvider() })

    // Give the query and its effects room to settle.
    await waitFor(() => expect(getActiveLocale()).toBeTruthy())

    expect(announced).not.toContain('en')
    unsubscribe()
  })

  it('leaves the mirrored locale intact across a mount', async () => {
    setActiveLocale('ja')

    renderHook(() => useAppLanguage(), { wrapper: createTestProvider() })
    await waitFor(() => expect(getActiveLocale()).toBeTruthy())

    expect(localStorage.getItem(storageKey)).toBe('ja')
  })
})
