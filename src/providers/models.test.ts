/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, expect, it } from 'bun:test'
import { getDb } from '@/db/database'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getAllModels, getModel, updateModel } from '@/dal/models'
import {
  deleteProviderConnection,
  disconnectProviderConnection,
  saveProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { modelProfilesTable } from '@/db/tables'
import { addProviderModels } from './models'

beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)

const connect = (provider: 'openai' | 'exa' = 'openai') =>
  saveProviderConnection(getDb(), {
    provider,
    name: 'Work',
    authMethod: 'api_key',
    credentials: { apiKey: 'key' },
  })

it.each(['missing', 'disabled', 'disconnected', 'deleted', 'search-only'] as const)(
  'does not add models to a %s connection',
  async (state) => {
    const id = state === 'missing' ? 'missing' : await connect(state === 'search-only' ? 'exa' : 'openai')
    if (state === 'disabled') {
      await updateProviderConnection(getDb(), id, { enabled: false })
    }
    if (state === 'disconnected') {
      await disconnectProviderConnection(getDb(), id)
    }
    if (state === 'deleted') {
      await deleteProviderConnection(getDb(), id)
    }
    await expect(addProviderModels(getDb(), id, [{ id: 'test' }])).rejects.toThrow('Connect the provider')
    expect(await getAllModels(getDb())).toEqual([])
  },
)

it('rolls back earlier additions if one selected catalog entry is invalid', async () => {
  const id = await connect()
  await expect(addProviderModels(getDb(), id, [{ id: 'valid' }, { id: ' ' }])).rejects.toThrow('model ID')
  expect(await getAllModels(getDb())).toEqual([])
})

it('leaves existing model preferences intact when the catalog selects the same model again', async () => {
  const id = await connect()
  const [modelId] = await addProviderModels(getDb(), id, [{ id: 'test', name: 'Catalog name' }])
  await updateModel(getDb(), modelId, { name: 'My name', enabled: 0, toolUsage: 0 })
  await getDb().insert(modelProfilesTable).values({ modelId, temperature: 0.3 })
  expect(
    await addProviderModels(getDb(), id, [{ id: 'test', name: 'New catalog name', supports_tools: true }]),
  ).toEqual([modelId])
  expect(await getModel(getDb(), modelId)).toMatchObject({ name: 'My name', enabled: 0, toolUsage: 0 })
  expect(await getDb().select().from(modelProfilesTable)).toMatchObject([{ modelId, temperature: 0.3 }])
})

it('does not add a model after its owning operation was canceled', async () => {
  const id = await connect()
  const controller = new AbortController()
  controller.abort()
  await expect(addProviderModels(getDb(), id, [{ id: 'test' }], { signal: controller.signal })).rejects.toThrow()
  expect(await getAllModels(getDb())).toEqual([])
})
