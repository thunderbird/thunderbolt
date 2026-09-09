/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettingsRecords, updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { setActiveLocale } from '@/i18n/active-locale'
import type { HttpClient, RequestOptions, ResponsePromise } from '@/lib/http'
import { getClock } from '@/testing-library'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { useLocationNameDisplay } from './use-location-name-display'
import { useSettings } from './use-settings'

const munique = { id: 2867714, name: 'Munique', region: 'Baviera', country: 'Alemanha', countryCode: 'DE' }

type Recorded = { url: string; language: unknown }

/**
 * Records every lookup so a test can assert the *absence* of one — the whole
 * point of the stored setting — and can fail the request to stand in for an
 * offline device.
 */
const createFakeHttpClient = (recorded: Recorded[], { fails = false } = {}): HttpClient => {
  const get = (url: string, options?: RequestOptions): ResponsePromise => {
    recorded.push({ url, language: (options?.searchParams as Record<string, unknown> | undefined)?.language })
    // Only the body rejects, not the returned thenable: callers reach the
    // payload through `.json()`, so rejecting the outer promise as well would
    // leave one nobody awaits and fail the run as an unhandled rejection.
    const promise = Promise.resolve(new Response('{}')) as ResponsePromise
    const body = async () => {
      if (fails) {
        throw new Error('network unreachable')
      }
      return munique
    }
    promise.json = body as ResponsePromise['json']
    promise.text = async () => JSON.stringify(munique)
    return promise
  }

  const unsupported = (): ResponsePromise => {
    throw new Error('not implemented')
  }

  return { get, post: unsupported, delete: unsupported }
}

const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

/**
 * The setting row has to exist before mounting: the PowerSync test mock never
 * re-emits a watched query, so a row written after mount stays invisible to the
 * hook (same constraint as `use-app-language.test.tsx`).
 */
const renderWithSettings = (httpClient: HttpClient) =>
  renderHook(
    () => {
      const { locationId, locationName, locationNameDisplay } = useSettings({
        location_id: '',
        location_name: '',
        location_name_display: '',
      })
      return {
        display: useLocationNameDisplay(locationId.value, locationName.value, locationNameDisplay),
        isLoading: locationNameDisplay.isLoading,
      }
    },
    { wrapper: createTestProvider({ httpClient }) },
  )

const storedDisplayName = async () => {
  const [record] = await getSettingsRecords(getDb(), ['location_name_display'])
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
})

describe('useLocationNameDisplay', () => {
  it('renders the stored display name without a lookup', async () => {
    setActiveLocale('pt-BR')
    await updateSettings(getDb(), {
      location_id: '2867714',
      location_name: 'Munich, Bavaria, Germany',
      location_name_display: 'Munique, Baviera, Alemanha',
    })
    const recorded: Recorded[] = []

    const { result } = renderWithSettings(createFakeHttpClient(recorded))
    await flush()

    expect(result.current.display).toBe('Munique, Baviera, Alemanha')
    expect(recorded).toEqual([])
  })

  /**
   * The refill path: a location saved before the setting existed, or one whose
   * row a language change cleared. Resolves once and persists the result, so
   * the next page load is back to the no-lookup case above.
   */
  it('resolves and stores the display name when the row is empty', async () => {
    setActiveLocale('pt-BR')
    await updateSettings(getDb(), { location_id: '2867714', location_name: 'Munich, Bavaria, Germany' })
    const recorded: Recorded[] = []

    const httpClient = createFakeHttpClient(recorded)
    renderWithSettings(httpClient)
    await flush()

    expect(recorded).toEqual([{ url: 'locations/2867714', language: 'pt-BR' }])
    expect(await storedDisplayName()).toBe('Munique, Baviera, Alemanha')

    // Asserted from a second mount rather than from the first one's return
    // value: the PowerSync test mock never re-emits, so the hook that wrote the
    // row cannot observe it. A fresh mount is also the case that matters — the
    // next page load reads the stored name and stays off the network.
    const remounted = renderWithSettings(httpClient)
    await flush()

    expect(remounted.result.current.display).toBe('Munique, Baviera, Alemanha')
    expect(recorded).toHaveLength(1)
  })

  /**
   * A lookup while the query is still in flight would fire on every mount,
   * defeating the setting — the stored value reads as empty until it settles.
   */
  it('does not resolve off the empty value the query reports while loading', () => {
    setActiveLocale('pt-BR')
    const recorded: Recorded[] = []

    const { result } = renderWithSettings(createFakeHttpClient(recorded))

    expect(result.current.isLoading).toBe(true)
    expect(recorded).toEqual([])
  })

  it('never looks up under English, where the stored name is already correct', async () => {
    await updateSettings(getDb(), { location_id: '2867714', location_name: 'Munich, Bavaria, Germany' })
    const recorded: Recorded[] = []

    const { result } = renderWithSettings(createFakeHttpClient(recorded))
    await flush()

    expect(result.current.display).toBe('Munich, Bavaria, Germany')
    expect(recorded).toEqual([])
  })

  it('has nothing to resolve against for a location saved without an id', async () => {
    setActiveLocale('pt-BR')
    await updateSettings(getDb(), { location_name: 'Munich, Bavaria, Germany' })
    const recorded: Recorded[] = []

    const { result } = renderWithSettings(createFakeHttpClient(recorded))
    await flush()

    expect(result.current.display).toBe('Munich, Bavaria, Germany')
    expect(recorded).toEqual([])
  })

  /** An offline device keeps a working English name rather than an error. */
  it('falls back to the English name when the lookup fails', async () => {
    setActiveLocale('pt-BR')
    await updateSettings(getDb(), { location_id: '2867714', location_name: 'Munich, Bavaria, Germany' })
    const recorded: Recorded[] = []

    const { result } = renderWithSettings(createFakeHttpClient(recorded, { fails: true }))
    await flush()

    expect(recorded).toHaveLength(1)
    expect(await storedDisplayName()).toBeNull()
    expect(result.current.display).toBe('Munich, Bavaria, Germany')
  })

  it('renders nothing when no location is saved', async () => {
    setActiveLocale('pt-BR')
    const recorded: Recorded[] = []

    const { result } = renderWithSettings(createFakeHttpClient(recorded))
    await flush()

    expect(result.current.display).toBe('')
    expect(recorded).toEqual([])
  })
})
