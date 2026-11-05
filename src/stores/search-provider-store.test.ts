/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { useSearchProviderStore } from './search-provider-store'

const storageKey = 'thunderbolt-search-provider'

/** Replays the storage notification delivered to other windows after a persistent change. */
const storageChanged = (key: string | null = storageKey, storageArea: Storage = localStorage) => {
  window.dispatchEvent(new StorageEvent('storage', { key, storageArea }))
}

afterEach(() => useSearchProviderStore.getState().clearSearchProvider())

describe('search credentials across windows', () => {
  it.each(['not_configured', 'workspace_disabled', 'unknown'] as const)(
    'preserves an explicit fallback when Otari search is %s',
    (searchStatus) => {
      useSearchProviderStore.getState().configureSearchProvider('saved-exa', 'exa')
      const connection = { modelId: 'model', url: 'https://otari.example/api/v1', searchStatus }
      useSearchProviderStore.getState().configureOtariSearch(connection)
      expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'custom', apiKey: 'saved-exa' })
      useSearchProviderStore.getState().selectSearchProvider('otari')
      useSearchProviderStore.getState().configureOtariSearch(connection)
      expect(useSearchProviderStore.getState().selection).toBe('auto')
    },
  )

  it('selects Otari by model reference, preserving other search keys without copying the OAuth token', () => {
    useSearchProviderStore.getState().configureSearchProvider('saved-exa', 'exa')
    useSearchProviderStore.getState().configureOtariSearch({
      searchStatus: 'available' as const,
      modelId: 'otari-model',
      url: 'https://otari.example/api/v1',
    })
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      state: {
        selection: 'otari',
        apiKey: 'saved-exa',
        provider: 'exa',
        otariConnection: {
          searchStatus: 'available' as const,
          modelId: 'otari-model',
          url: 'https://otari.example/api/v1',
        },
      },
    })
    localStorage.removeItem(storageKey)
    storageChanged()
    expect(useSearchProviderStore.getState().otariConnection).toBeNull()
  })
  it('stops retaining a key disconnected in another window without writing it back', () => {
    useSearchProviderStore.getState().configureSearchProvider('old-key', 'exa')
    const disconnected = JSON.stringify({ state: { provider: null, apiKey: '', selection: 'none' }, version: 0 })
    localStorage.setItem(storageKey, disconnected)
    storageChanged()
    expect(useSearchProviderStore.getState()).toMatchObject({ provider: null, apiKey: '', selection: 'none' })
    expect(localStorage.getItem(storageKey)).toBe(disconnected)
  })

  it.each([storageKey, null])('drops cached credentials when storage is removed (%s)', (eventKey) => {
    useSearchProviderStore.getState().configureSearchProvider('old-key', 'brave')
    localStorage.removeItem(storageKey)
    storageChanged(eventKey)
    expect(useSearchProviderStore.getState()).toMatchObject({ provider: null, apiKey: '', selection: 'auto' })
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it('uses the current key and selection when another window changes provider', () => {
    useSearchProviderStore.getState().configureSearchProvider('old-key', 'exa')
    localStorage.setItem(
      storageKey,
      JSON.stringify({ state: { provider: 'tavily', apiKey: 'replacement-key', selection: 'custom' }, version: 0 }),
    )
    storageChanged()
    expect(useSearchProviderStore.getState()).toMatchObject({
      provider: 'tavily',
      apiKey: 'replacement-key',
      selection: 'custom',
    })
  })

  it('ignores unrelated or session-storage events', () => {
    useSearchProviderStore.getState().configureSearchProvider('current-key', 'exa')
    localStorage.removeItem(storageKey)
    storageChanged('unrelated-key')
    storageChanged(storageKey, sessionStorage)
    expect(useSearchProviderStore.getState().apiKey).toBe('current-key')
  })
})
