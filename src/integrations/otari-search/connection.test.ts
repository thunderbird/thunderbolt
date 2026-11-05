/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createModel, updateModel } from '@/dal/models'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { http } from '@/lib/http'
import { createConfigs } from '@/integrations/thunderbolt-pro/tools'
import { getOtariSearchConnection, getOtariSearchAvailability } from './connection'

const connection = { searchStatus: 'available' as const, modelId: 'otari-model', url: 'https://gateway.example/api/v1' }

/** Models the two independent capabilities advertised by the gateway. */
const toolsResponse = (fetch = true, search = true) =>
  Response.json({
    data: [
      {
        id: 'otari_web_search',
        available: search,
        direct_available: search,
        reason: search ? null : 'workspace_disabled',
      },
      { id: 'otari_web_fetch', available: fetch, direct_available: fetch, reason: fetch ? null : 'not_configured' },
    ],
  })

/** Saves an OAuth model and explicitly registers its gateway for search. */
const connect = async () => {
  await createModel(getDb(), {
    id: connection.modelId,
    name: 'Otari',
    provider: 'otari',
    model: 'test',
    url: connection.url,
    apiKey: 'delegated-key',
    enabled: 1,
    toolUsage: 0,
  })
  useSearchProviderStore.getState().configureOtariSearch(connection)
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

it('reuses the registered model credential without requiring tool support in that model', async () => {
  await connect()
  const fetch = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolsResponse())
    .mockResolvedValue(Response.json({ results: [] }))
  const { otariSearchApi } = await getOtariSearchConnection(getDb())
  await otariSearchApi!.search({ query: 'test', max_results: 8 }, http)
  expect(new Request(fetch.mock.calls[0][0]).url).toBe(`${connection.url}/tools`)
  expect(new Request(fetch.mock.calls[1][0]).headers.get('Authorization')).toBe('Bearer delegated-key')
  expect(await getOtariSearchAvailability(getDb())).toEqual({ otari: true, otariConfigured: true })
})

it('offers fetch only while the gateway advertises it, without requiring a reconnect', async () => {
  await connect()
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(toolsResponse(false))
  const searchOnly = await getOtariSearchConnection(getDb())
  expect(createConfigs(http, [], searchOnly.otariSearchApi).map((tool) => tool.name)).toEqual(['search'])

  fetch.mockResolvedValue(toolsResponse())
  const withFetch = await getOtariSearchConnection(getDb())
  expect(createConfigs(http, [], withFetch.otariSearchApi).map((tool) => tool.name)).toEqual([
    'search',
    'fetch_content',
  ])

  fetch.mockResolvedValue(toolsResponse(false))
  expect((await getOtariSearchConnection(getDb())).otariSearchApi?.fetchContent).toBeUndefined()
})

it('does not advertise cached web access after the workspace disables it', async () => {
  await connect()
  spyOn(globalThis, 'fetch').mockResolvedValue(toolsResponse(false, false))
  expect(await getOtariSearchConnection(getDb())).toEqual({ otariSearchApi: undefined, otariConfigured: true })
})

it('does not advertise web tools when capability discovery fails', async () => {
  await connect()
  spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }))
  expect(await getOtariSearchConnection(getDb())).toEqual({ otariSearchApi: undefined, otariConfigured: true })
})

it.each([
  { enabled: 0 },
  { apiKey: null },
  { deletedAt: '2026-11-05T00:00:00Z' },
  { url: 'https://different.example/api/v1' },
  { provider: 'openai' as const },
  { isSystem: 1 },
  { oauthProvider: 'tinfoil' as const },
])('retires a turn’s search connection when the saved model changes (%j)', async (change) => {
  await connect()
  const fetch = spyOn(globalThis, 'fetch')
  const { otariSearchApi } = await getOtariSearchConnection(getDb())
  fetch.mockClear()
  await updateModel(getDb(), connection.modelId, change)
  await expect(otariSearchApi!.search({ query: 'private query', max_results: 8 }, http)).rejects.toThrow('disconnected')
  expect(fetch).not.toHaveBeenCalled()
  expect(await getOtariSearchAvailability(getDb())).toEqual({ otari: false, otariConfigured: true })
})

it('retires a running turn after key rotation and exposes the new key only to a new turn', async () => {
  await connect()
  const { otariSearchApi } = await getOtariSearchConnection(getDb())
  await updateModel(getDb(), connection.modelId, { apiKey: 'replacement' })
  await expect(otariSearchApi!.search({ query: 'test', max_results: 8 }, http)).rejects.toThrow('Start a new turn')
  expect((await getOtariSearchAvailability(getDb())).otari).toBe(true)
})

it('never infers an Otari connection from a custom model URL or name and honors removal in another window', async () => {
  await connect()
  const { otariSearchApi } = await getOtariSearchConnection(getDb())
  useSearchProviderStore.getState().clearSearchProvider()
  expect(await getOtariSearchConnection(getDb())).toEqual({ otariSearchApi: undefined, otariConfigured: false })
  await expect(otariSearchApi!.search({ query: 'test', max_results: 8 }, http)).rejects.toThrow('disconnected')
})

it.each(['not_configured', 'workspace_disabled', 'unknown'] as const)(
  'rechecks a previously unavailable connection and recovers after search is enabled (%s)',
  async (searchStatus) => {
    await connect()
    useSearchProviderStore.getState().configureOtariSearch({ ...connection, searchStatus })
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(toolsResponse(false, false))
    expect(await getOtariSearchAvailability(getDb())).toEqual({ otari: true, otariConfigured: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(await getOtariSearchConnection(getDb())).toEqual({ otariSearchApi: undefined, otariConfigured: true })
    expect((await getOtariSearchConnection(getDb())).otariSearchApi?.search).toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([request]) => new Request(request).url === `${connection.url}/tools`)).toBe(true)
  },
)

it('recovers from a failed discovery without reconnecting or updating the cached onboarding status', async () => {
  await connect()
  useSearchProviderStore.getState().configureOtariSearch({ ...connection, searchStatus: 'unknown' })
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network unavailable'))
  expect(await getOtariSearchConnection(getDb())).toEqual({ otariSearchApi: undefined, otariConfigured: true })
  expect((await getOtariSearchConnection(getDb())).otariSearchApi?.search).toBeDefined()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(useSearchProviderStore.getState().otariConnection?.searchStatus).toBe('unknown')
})

it('retires a running connection when another gateway is registered, even if it uses the same model key', async () => {
  await connect()
  const { otariSearchApi } = await getOtariSearchConnection(getDb())
  useSearchProviderStore.getState().configureOtariSearch({ ...connection, url: 'https://other.example/api/v1' })
  const fetch = spyOn(globalThis, 'fetch').mockClear()
  await expect(otariSearchApi!.search({ query: 'private query', max_results: 8 }, http)).rejects.toThrow('disconnected')
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps a missing model unavailable instead of substituting another account', async () => {
  await connect()
  useSearchProviderStore.getState().configureOtariSearch({ ...connection, modelId: 'missing' })
  expect(await getOtariSearchAvailability(getDb())).toEqual({ otari: false, otariConfigured: true })
})
