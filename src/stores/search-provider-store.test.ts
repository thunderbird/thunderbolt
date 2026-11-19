/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it } from 'bun:test'
import { legacySearchStorageKey, searchSelectionStorageKey, useSearchProviderStore } from './search-provider-store'

afterEach(() => useSearchProviderStore.getState().clearSearchProvider())
it('persists only connection identity, selection and capability status', () => {
  useSearchProviderStore.getState().configureProviderSearch('oauth:otari', 'available')
  expect(JSON.parse(localStorage.getItem(searchSelectionStorageKey)!).state).toEqual({
    selection: 'connection',
    connectionId: 'oauth:otari',
    connectionStatus: { connectionId: 'oauth:otari', status: 'available' },
  })
})
it.each(['not_configured', 'workspace_disabled', 'unknown'] as const)(
  'keeps the current choice when Otari reports %s',
  (status) => {
    useSearchProviderStore.getState().selectSearchConnection('own-exa')
    useSearchProviderStore.getState().configureProviderSearch('oauth:otari', status)
    expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: 'own-exa' })
    expect(useSearchProviderStore.getState().connectionStatus).toEqual({ connectionId: 'oauth:otari', status })
  },
)
it('selects confirmed built-in search and keeps disabling search separate from disconnecting', () => {
  useSearchProviderStore.getState().selectSearchProvider('none')
  useSearchProviderStore.getState().configureProviderSearch('oauth:tinfoil', 'available')
  expect(useSearchProviderStore.getState().connectionId).toBe('oauth:tinfoil')
  useSearchProviderStore.getState().selectSearchProvider('none')
  expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'none', connectionId: null })
})
it.each(['auto', 'cloud', 'none', 'connection'] as const)(
  'records verified capability without changing the current %s selection when saving in Settings',
  (selection) => {
    if (selection === 'connection') {
      useSearchProviderStore.getState().selectSearchConnection('existing-search')
    } else {
      useSearchProviderStore.getState().selectSearchProvider(selection)
    }
    useSearchProviderStore.getState().configureProviderSearch('oauth:otari', 'available', { select: false })
    expect(useSearchProviderStore.getState()).toMatchObject({
      selection,
      connectionId: selection === 'connection' ? 'existing-search' : null,
      connectionStatus: { connectionId: 'oauth:otari', status: 'available' },
    })
  },
)
it('drops stale routing when another window clears its storage', async () => {
  useSearchProviderStore.getState().selectSearchConnection('private')
  localStorage.removeItem(searchSelectionStorageKey)
  await useSearchProviderStore.persist.rehydrate()
  expect(useSearchProviderStore.getState()).toMatchObject({
    selection: 'auto',
    connectionId: null,
    connectionStatus: null,
  })
})

it('removes an unmigrated legacy key during account cleanup', () => {
  localStorage.setItem(
    legacySearchStorageKey,
    JSON.stringify({ state: { provider: 'exa', apiKey: 'old-account-key' } }),
  )
  useSearchProviderStore.getState().clearSearchProvider()
  expect(localStorage.getItem(legacySearchStorageKey)).toBeNull()
})
