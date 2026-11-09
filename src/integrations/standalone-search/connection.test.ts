/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { providerConnectionsTable } from '@/db/tables'
import {
  disconnectProviderConnection,
  saveProviderConnection,
  saveProviderConnectionInTransaction,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { createModel, updateModel } from '@/dal/models'
import { updateSettings } from '@/dal/settings'
import * as providerConnections from '@/dal/provider-connections'
import { tinfoilSession } from '@/lib/tinfoil-session'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { http } from '@/lib/http'
import { getSearchConnectionApi, getSearchConnectionAuthorization } from './connection'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'

const url = 'https://gateway.example/api/v1'
const toolsResponse = (search = true, fetch = true) =>
  Response.json({
    data: [
      { id: 'otari_web_search', direct_available: search, reason: search ? null : 'workspace_disabled' },
      { id: 'otari_web_fetch', direct_available: fetch },
    ],
  })
const connect = async (provider: 'otari' | 'tinfoil' | 'exa' | 'brave' | 'tavily' = 'otari', enableOtari = true) => {
  if (provider === 'otari' && enableOtari) {
    await updateSettings(getDb(), { experimental_feature_otari: true })
  }
  const id = await saveProviderConnection(getDb(), {
    id: 'connection',
    provider,
    name: 'My connection',
    url: provider === 'otari' ? url : null,
    authMethod: 'api_key',
    credentials: { apiKey: 'key' },
  })
  useSearchProviderStore.getState().selectSearchConnection(id)
  return id
}
beforeAll(setupTestDatabase)
beforeEach(() => {
  spyOn(globalThis, 'fetch').mockResolvedValue(toolsResponse())
})
afterAll(teardownTestDatabase)
afterEach(async () => {
  mock.restore()
  useSearchProviderStore.getState().clearSearchProvider()
  await resetTestDatabase()
})

it.each(['missing', 'disabled'] as const)(
  'blocks hidden Otari before credentials or discovery when %s',
  async (flag) => {
    const id = await connect('otari', false)
    if (flag === 'disabled') {
      await updateSettings(getDb(), { experimental_feature_otari: false })
    }
    const credentials = spyOn(providerConnections, 'getProviderCredentials')
    const resolve = spyOn(providerConnections, 'resolveProviderConnection')
    const fetch = spyOn(globalThis, 'fetch').mockClear()

    expect(await getSearchConnectionAuthorization(getDb(), id)).toBeNull()
    expect(await getSearchConnectionApi(getDb(), id)).toBeUndefined()
    expect(credentials).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: id })
  },
)

it.each(['search', 'fetch'] as const)(
  'blocks an existing Otari %s API before credentials when preview is disabled',
  async (tool) => {
    const id = await connect()
    const api = await getSearchConnectionApi(getDb(), id)
    await updateSettings(getDb(), { experimental_feature_otari: false })
    const resolve = spyOn(providerConnections, 'resolveProviderConnection')
    const fetch = spyOn(globalThis, 'fetch').mockClear()

    const request =
      tool === 'search'
        ? api!.search({ query: 'private query', max_results: 1 }, http)
        : api!.fetchContent!({ url: 'https://example.com/private' }, http)
    await expect(request).rejects.toThrow('Otari preview is disabled')
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: id })
  },
)

it('rejects Otari if its preview is disabled while credentials resolve', async () => {
  const id = await connect()
  const api = await getSearchConnectionApi(getDb(), id)
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<void>()
  const resolve = providerConnections.resolveProviderConnection
  spyOn(providerConnections, 'resolveProviderConnection').mockImplementation(async (...args) => {
    const authorization = await resolve(...args)
    started.resolve()
    await pending.promise
    return authorization
  })
  const fetch = spyOn(globalThis, 'fetch').mockClear()
  const request = api!.search({ query: 'private query', max_results: 1 }, http)
  await started.promise
  await updateSettings(getDb(), { experimental_feature_otari: false })
  pending.resolve()

  await expect(request).rejects.toThrow('Otari preview is disabled')
  expect(fetch).not.toHaveBeenCalled()
})

it('uses Otari with no models and keeps search after a model is disabled', async () => {
  const id = await connect()
  const api = await getSearchConnectionApi(getDb(), id)
  expect(api?.search).toBeDefined()
  await createModel(getDb(), {
    id: 'model',
    name: 'Model',
    provider: 'otari',
    providerConnectionId: id,
    model: 'test',
    enabled: 1,
  })
  await updateModel(getDb(), 'model', { enabled: 0 })
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ results: [] }))
  await api!.search({ query: 'test', max_results: 1 }, http)
  expect(new Request(fetch.mock.calls.at(-1)![0]).headers.get('Authorization')).toBe('Bearer key')
})
it.each(['otari', 'tinfoil', 'exa', 'brave', 'tavily'] as const)(
  'retires a retained %s search client after identity teardown before reading credentials',
  async (provider) => {
    const id = await connect(provider)
    const api = await getSearchConnectionApi(getDb(), id)
    const fetch = spyOn(globalThis, 'fetch').mockClear()
    const resolve = spyOn(providerConnections, 'resolveProviderConnection')
    invalidateIdentityLifetime()
    await expect(api!.search({ query: 'private query', max_results: 1 }, http)).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  },
)

it('aborts an in-flight Otari search request on identity teardown', async () => {
  const id = await connect()
  const api = await getSearchConnectionApi(getDb(), id)
  const started = Promise.withResolvers<AbortSignal>()
  const send = async (input: RequestInfo | URL) => {
    const signal = (input as Request).signal
    started.resolve(signal)
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  send.preconnect = globalThis.fetch.preconnect
  spyOn(globalThis, 'fetch').mockImplementation(send)
  const request = api!.search({ query: 'private query', max_results: 1 }, http)
  const signal = await started.promise
  invalidateIdentityLifetime()
  expect(signal.aborted).toBe(true)
  await expect(request).rejects.toHaveProperty('name', 'AbortError')
})
it.each(['not_configured', 'workspace_disabled', 'unknown'] as const)(
  'rediscovers Otari after cached %s',
  async (status) => {
    const id = await connect()
    useSearchProviderStore.getState().configureProviderSearch(id, status)
    const fetch = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolsResponse(false))
      .mockResolvedValue(toolsResponse())
    expect(await getSearchConnectionApi(getDb(), id)).toBeUndefined()
    expect((await getSearchConnectionApi(getDb(), id))?.search).toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  },
)
it('fails closed on discovery errors and exposes fetch only when advertised', async () => {
  const id = await connect()
  const fetch = spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(toolsResponse(true, false))
    .mockResolvedValue(toolsResponse())
  expect(await getSearchConnectionApi(getDb(), id)).toBeUndefined()
  expect((await getSearchConnectionApi(getDb(), id))?.fetchContent).toBeUndefined()
  expect((await getSearchConnectionApi(getDb(), id))?.fetchContent).toBeDefined()
  expect(fetch).toHaveBeenCalledTimes(3)
})
it.each(['disabled', 'reenabled', 'disconnected', 'rotated', 'url', 'provider', 'deleted'] as const)(
  'retires an active turn after %s without sending its query',
  async (change) => {
    const id = await connect()
    const api = await getSearchConnectionApi(getDb(), id)
    if (change === 'disabled' || change === 'reenabled') {
      await updateProviderConnection(getDb(), id, { enabled: false })
      if (change === 'reenabled') {
        await updateProviderConnection(getDb(), id, { enabled: true })
      }
    }
    if (change === 'disconnected') {
      await disconnectProviderConnection(getDb(), id)
    }
    if (change === 'rotated') {
      await saveProviderConnection(getDb(), {
        id,
        provider: 'otari',
        name: 'Changed',
        url,
        authMethod: 'api_key',
        credentials: { apiKey: 'new-key' },
      })
    }
    if (change === 'url') {
      await getDb()
        .update(providerConnectionsTable)
        .set({ url: 'https://untrusted.example/api/v1' })
        .where(eq(providerConnectionsTable.id, id))
    }
    if (change === 'provider') {
      await getDb()
        .update(providerConnectionsTable)
        .set({ provider: 'tinfoil' })
        .where(eq(providerConnectionsTable.id, id))
    }
    if (change === 'deleted') {
      await getDb()
        .update(providerConnectionsTable)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(providerConnectionsTable.id, id))
    }
    const fetch = spyOn(globalThis, 'fetch').mockClear()
    await expect(api!.search({ query: 'private query', max_results: 1 }, http)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  },
)
it('does not expose a missing connection or substitute another account', async () => {
  await connect()
  expect(await getSearchConnectionApi(getDb(), 'missing')).toBeUndefined()
})
it.each(['exa', 'brave', 'tavily', 'tinfoil'] as const)(
  'resolves %s credentials at call time without models',
  async (provider) => {
    await updateSettings(getDb(), { experimental_feature_otari: false })
    const id = await connect(provider)
    const authorization = await getSearchConnectionAuthorization(getDb(), id)
    expect(await authorization!.getApiKey()).toBe('key')
    expect((await getSearchConnectionApi(getDb(), id))?.fetchContent === undefined).toBe(provider === 'brave')
    await disconnectProviderConnection(getDb(), id)
    await expect(authorization!.getApiKey()).rejects.toThrow()
  },
)
it('lets Tinfoil OAuth refresh without changing the turn’s connection identity', async () => {
  const id = await getDb().transaction((tx) =>
    saveProviderConnectionInTransaction(tx, {
      provider: 'tinfoil',
      name: 'Tinfoil',
      authMethod: 'oauth',
      credentials: { access_token: 'old', refresh_token: 'refresh' },
    }),
  )
  const token = spyOn(tinfoilSession, 'getAccessToken')
    .mockResolvedValueOnce('first')
    .mockResolvedValueOnce('refreshed')
  const authorization = await getSearchConnectionAuthorization(getDb(), id)
  expect(await authorization!.getApiKey()).toBe('first')
  expect(await authorization!.getApiKey()).toBe('refreshed')
  expect(token).toHaveBeenCalledTimes(2)
})
it('rejects a synced disable that wins while an OAuth refresh is in flight', async () => {
  const id = await getDb().transaction((tx) =>
    saveProviderConnectionInTransaction(tx, {
      provider: 'tinfoil',
      name: 'Tinfoil',
      authMethod: 'oauth',
      credentials: { access_token: 'old', expires_at: Date.now() + 3_600_000 },
    }),
  )
  const pending = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  spyOn(tinfoilSession, 'getAccessToken').mockImplementation(() => {
    started.resolve()
    return pending.promise
  })
  const authorization = await getSearchConnectionAuthorization(getDb(), id)
  const running = authorization!.getApiKey()
  await started.promise
  await getDb().update(providerConnectionsTable).set({ enabled: 0 }).where(eq(providerConnectionsTable.id, id))
  pending.resolve('stale')
  await expect(running).rejects.toThrow()
})
