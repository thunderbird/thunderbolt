/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createModel, updateModel } from '@/dal/models'
import { saveIntegrationCredentials } from '@/dal/integrations'
import { tinfoilSession } from '@/lib/tinfoil-session'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createTinfoilWebApi } from './api'
import { getTinfoilSearchConnection } from './connection'
import { resolveSearchSelection } from '@/integrations/standalone-search/selection'
import { createMockHttpClient } from '@/test-utils/http-client'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(async () => {
  mock.restore()
  await resetTestDatabase()
  useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
})

it.each([true, false])('uses OAuth search and honors disable during a turn (local mode: %s)', async (localMode) => {
  useLocalSettingsStore.setState({ cloudUrl: localMode ? '' : 'https://server.example/v1', localMode })
  await createModel(getDb(), {
    id: 'oauth',
    name: 'Tinfoil',
    provider: 'tinfoil',
    model: 'test',
    oauthProvider: 'tinfoil',
    enabled: 1,
    toolUsage: 1,
  })
  await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'saved-token' }, true)
  const access = spyOn(tinfoilSession, 'getAccessToken').mockResolvedValue('fresh-token')
  const { tinfoilSearchApi: api } = await getTinfoilSearchConnection(getDb(), (getKey) =>
    createTinfoilWebApi(getKey, async () => {
      expect(await getKey()).toBe('fresh-token')
      return { structuredContent: { results: [] } }
    }),
  )
  expect(api).toBeDefined()
  await api!.search({ query: 'test', max_results: 1 }, createMockHttpClient())
  expect(access).toHaveBeenCalledTimes(1)
  await updateModel(getDb(), 'oauth', { enabled: 0 })
  expect((await getTinfoilSearchConnection(getDb())).tinfoilSearchApi).toBeDefined()
  await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'saved-token' }, false)
  access.mockImplementation(async () => {
    throw new Error('no longer connected')
  })
  await expect(api!.search({ query: 'test', max_results: 1 }, createMockHttpClient())).rejects.toThrow(
    'no longer connected',
  )
  expect((await getTinfoilSearchConnection(getDb())).tinfoilSearchApi).toBeUndefined()
})

it('uses BYOK search with no separate search key and does not reuse a disconnected credential', async () => {
  useLocalSettingsStore.setState({ cloudUrl: '' })
  await createModel(getDb(), {
    id: 'byok',
    name: 'Tinfoil',
    provider: 'tinfoil',
    model: 'test',
    apiKey: 'own-key',
    enabled: 1,
    toolUsage: 1,
  })
  const { tinfoilSearchApi: api } = await getTinfoilSearchConnection(getDb(), (getKey) =>
    createTinfoilWebApi(getKey, async () => {
      expect(await getKey()).toBe('own-key')
      return { structuredContent: { results: [] } }
    }),
  )
  await api!.search({ query: 'test', max_results: 1 }, createMockHttpClient())
  await updateModel(getDb(), 'byok', { apiKey: null })
  await expect(api!.search({ query: 'test', max_results: 1 }, createMockHttpClient())).rejects.toThrow(
    'no longer connected',
  )
})

it('does not expose a missing or expired OAuth session', async () => {
  useLocalSettingsStore.setState({ cloudUrl: '' })
  await createModel(getDb(), {
    id: 'oauth',
    name: 'Tinfoil',
    provider: 'tinfoil',
    model: 'test',
    oauthProvider: 'tinfoil',
    enabled: 1,
  })
  expect((await getTinfoilSearchConnection(getDb())).tinfoilSearchApi).toBeUndefined()
  await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'old', reauth_required: true }, true)
  expect((await getTinfoilSearchConnection(getDb())).tinfoilSearchApi).toBeUndefined()
})

it('discovers OAuth search with no model row and BYOK search without model tool calling', async () => {
  await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'saved-token' }, true)
  expect((await getTinfoilSearchConnection(getDb())).tinfoilSearchApi).toBeDefined()
  await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'saved-token' }, false)
  expect((await getTinfoilSearchConnection(getDb())).tinfoilSearchApi).toBeUndefined()
  await createModel(getDb(), {
    id: 'no-tools',
    name: 'Tinfoil',
    provider: 'tinfoil',
    model: 'test',
    apiKey: 'own-key',
    enabled: 1,
    toolUsage: 0,
  })
  expect((await getTinfoilSearchConnection(getDb())).tinfoilSearchApi).toBeDefined()
})

it.each([
  { access_token: 'disabled', enabled: false },
  { access_token: '', enabled: false },
  { access_token: 'expired', reauth_required: true, enabled: true },
])(
  'retains private search intent when the OAuth connection is unavailable: %j',
  async ({ enabled, ...credentials }) => {
    await saveIntegrationCredentials(getDb(), 'tinfoil', credentials, enabled)
    const connection = await getTinfoilSearchConnection(getDb())
    expect(connection).toEqual({ tinfoilSearchApi: undefined, tinfoilConfigured: true })
    expect(
      resolveSearchSelection('auto', {
        custom: false,
        tinfoil: Boolean(connection.tinfoilSearchApi),
        tinfoilConfigured: connection.tinfoilConfigured,
        cloud: true,
      }),
    ).toBeNull()
  },
)

it('retains private search intent when a BYOK model is disabled', async () => {
  await createModel(getDb(), {
    id: 'disabled',
    name: 'Tinfoil',
    provider: 'tinfoil',
    model: 'test',
    apiKey: 'own-key',
    enabled: 0,
  })
  expect(await getTinfoilSearchConnection(getDb())).toEqual({ tinfoilSearchApi: undefined, tinfoilConfigured: true })
})

it('does not infer a private connection for an account that never configured one', async () => {
  expect(await getTinfoilSearchConnection(getDb())).toEqual({ tinfoilSearchApi: undefined, tinfoilConfigured: false })
})
