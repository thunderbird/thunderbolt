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
import { getTinfoilWebApi } from './connection'
import { createMockHttpClient } from '@/test-utils/http-client'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(async () => {
  mock.restore()
  await resetTestDatabase()
  useLocalSettingsStore.setState({ cloudUrl: '' })
})

it('uses OAuth credentials for normal search tools and honors disable during a turn', async () => {
  useLocalSettingsStore.setState({ cloudUrl: '' })
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
  const api = await getTinfoilWebApi(getDb(), (getKey) =>
    createTinfoilWebApi(getKey, async () => {
      expect(await getKey()).toBe('fresh-token')
      return { structuredContent: { results: [] } }
    }),
  )
  expect(api).toBeDefined()
  await api!.search({ query: 'test', max_results: 1 }, createMockHttpClient())
  expect(access).toHaveBeenCalledTimes(1)
  await updateModel(getDb(), 'oauth', { enabled: 0 })
  await expect(api!.search({ query: 'test', max_results: 1 }, createMockHttpClient())).rejects.toThrow(
    'no longer connected',
  )
  expect(await getTinfoilWebApi(getDb())).toBeUndefined()
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
  const api = await getTinfoilWebApi(getDb(), (getKey) =>
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
  expect(await getTinfoilWebApi(getDb())).toBeUndefined()
  await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'old', reauth_required: true }, true)
  expect(await getTinfoilWebApi(getDb())).toBeUndefined()
})
