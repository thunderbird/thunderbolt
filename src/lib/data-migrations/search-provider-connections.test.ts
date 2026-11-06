/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createModel } from '@/dal/models'
import * as connections from '@/dal/provider-connections'
import { providerConnectionsTable } from '@/db/tables'
import { searchSelectionStorageKey, useSearchProviderStore } from '@/stores/search-provider-store'
import { legacySearchStorageKey, migrateSearchProviderConnections } from './search-provider-connections'

const legacy = (state: Record<string, unknown>) =>
  localStorage.setItem(legacySearchStorageKey, JSON.stringify({ state, version: 0 }))
beforeAll(setupTestDatabase)
beforeEach(() => {
  useSearchProviderStore.getState().clearSearchProvider()
  localStorage.removeItem(searchSelectionStorageKey)
  localStorage.removeItem(legacySearchStorageKey)
})
afterAll(teardownTestDatabase)
afterEach(async () => {
  mock.restore()
  await resetTestDatabase()
  localStorage.removeItem(legacySearchStorageKey)
})
it.each(['exa', 'brave', 'tavily'] as const)(
  'moves the legacy %s key durably and removes it from localStorage',
  async (provider) => {
    legacy({ provider, apiKey: ' secret ', selection: 'custom' })
    await migrateSearchProviderConnections(getDb())
    expect(useSearchProviderStore.getState()).toMatchObject({
      selection: 'connection',
      connectionId: `legacy-search:${provider}`,
    })
    expect((await connections.getProviderCredentials(getDb(), `legacy-search:${provider}`))?.apiKey).toBe('secret')
    expect(localStorage.getItem(legacySearchStorageKey)).toBeNull()
    expect(localStorage.getItem(searchSelectionStorageKey)).not.toContain('secret')
    await migrateSearchProviderConnections(getDb())
    expect(await connections.getProviderConnections(getDb())).toHaveLength(1)
  },
)
it.each(['none', 'cloud'] as const)('preserves explicit %s while migrating a saved key', async (selection) => {
  legacy({ provider: 'exa', apiKey: 'secret', selection })
  await migrateSearchProviderConnections(getDb())
  expect(useSearchProviderStore.getState().selection).toBe(selection)
  expect(await connections.getProviderConnections(getDb())).toHaveLength(1)
})
it('preserves a newer selection and does not restore disconnected credentials on retry', async () => {
  legacy({ provider: 'exa', apiKey: 'old', selection: 'custom' })
  await migrateSearchProviderConnections(getDb())
  await connections.disconnectProviderConnection(getDb(), 'legacy-search:exa')
  useSearchProviderStore.getState().selectSearchProvider('none')
  legacy({ provider: 'exa', apiKey: 'old', selection: 'custom' })
  await migrateSearchProviderConnections(getDb())
  expect(useSearchProviderStore.getState().selection).toBe('none')
  expect(await connections.getProviderCredentials(getDb(), 'legacy-search:exa')).toBeNull()
})
it('keeps the old key recoverable when the durable write fails', async () => {
  legacy({ provider: 'exa', apiKey: 'secret', selection: 'custom' })
  const save = spyOn(connections, 'saveProviderConnectionInTransaction').mockRejectedValueOnce(
    new Error('Database unavailable'),
  )
  await expect(migrateSearchProviderConnections(getDb())).rejects.toThrow('Database unavailable')
  expect(localStorage.getItem(legacySearchStorageKey)).toContain('secret')
  expect(localStorage.getItem(searchSelectionStorageKey)).toBeNull()
  save.mockRestore()
  await migrateSearchProviderConnections(getDb())
  expect(localStorage.getItem(legacySearchStorageKey)).toBeNull()
})
it('maps the legacy Otari model to its reusable connection and preserves capability status', async () => {
  const id = await connections.saveProviderConnection(getDb(), {
    provider: 'otari',
    name: 'Work',
    url: 'https://otari.example/api/v1',
    authMethod: 'api_key',
    credentials: { apiKey: 'key' },
  })
  await createModel(getDb(), {
    id: 'old-model',
    name: 'Old',
    provider: 'otari',
    model: 'test',
    providerConnectionId: id,
  })
  legacy({
    selection: 'otari',
    otariConnection: { modelId: 'old-model', url: 'https://otari.example/api/v1', searchStatus: 'unknown' },
  })
  await migrateSearchProviderConnections(getDb())
  expect(useSearchProviderStore.getState()).toMatchObject({
    selection: 'connection',
    connectionId: id,
    connectionStatus: { connectionId: id, status: 'unknown' },
  })
})
it.each([true, false])(
  'retains actual legacy Tinfoil authorization independently of model enablement (%s)',
  async (enabled) => {
    const id = await connections.saveProviderConnection(getDb(), {
      provider: 'tinfoil',
      name: 'Tinfoil',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
      enabled,
    })
    await migrateSearchProviderConnections(getDb())
    expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: id })
  },
)
it('does not infer local intent from synced metadata and keeps Cloud available', async () => {
  await getDb()
    .insert(providerConnectionsTable)
    .values({ id: 'remote', provider: 'tinfoil', name: 'Remote', authMethod: 'api_key', enabled: 1 })
  await migrateSearchProviderConnections(getDb())
  expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'auto', connectionId: null })
})
it('keeps explicit disconnected Tinfoil intent instead of falling back to Cloud', async () => {
  legacy({ selection: 'tinfoil' })
  await migrateSearchProviderConnections(getDb())
  expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: 'oauth:tinfoil' })
})
it('does not leak malformed legacy configuration through the migration error', async () => {
  localStorage.setItem(legacySearchStorageKey, 'secret malformed JSON')
  await expect(migrateSearchProviderConnections(getDb())).rejects.toThrow(
    'The legacy search configuration could not be read',
  )
})

it('hydrates synced legacy search metadata with this device’s own key', async () => {
  await getDb()
    .insert(providerConnectionsTable)
    .values({ id: 'legacy-search:exa', provider: 'exa', name: 'Exa', url: null, authMethod: 'api_key', enabled: 1 })
  legacy({ provider: 'exa', apiKey: 'device-b-key', selection: 'custom' })
  await migrateSearchProviderConnections(getDb())
  expect((await connections.getProviderCredentials(getDb(), 'legacy-search:exa'))?.apiKey).toBe('device-b-key')
  expect(localStorage.getItem(legacySearchStorageKey)).toBeNull()
})
it('keeps the key recoverable and selection private when synced routing identity does not match', async () => {
  await getDb().insert(providerConnectionsTable).values({
    id: 'legacy-search:exa',
    provider: 'tinfoil',
    name: 'Changed',
    url: null,
    authMethod: 'api_key',
    enabled: 1,
  })
  legacy({ provider: 'exa', apiKey: 'private-key', selection: 'custom' })
  await migrateSearchProviderConnections(getDb())
  expect(await connections.getProviderCredentials(getDb(), 'legacy-search:exa')).toBeNull()
  expect(localStorage.getItem(legacySearchStorageKey)).toContain('private-key')
  expect(useSearchProviderStore.getState()).toMatchObject({
    selection: 'connection',
    connectionId: 'legacy-search:exa',
  })
  await getDb()
    .update(providerConnectionsTable)
    .set({ provider: 'exa' })
    .where(eq(providerConnectionsTable.id, 'legacy-search:exa'))
  await migrateSearchProviderConnections(getDb())
  expect((await connections.getProviderCredentials(getDb(), 'legacy-search:exa'))?.apiKey).toBe('private-key')
  expect(localStorage.getItem(legacySearchStorageKey)).toBeNull()
})
