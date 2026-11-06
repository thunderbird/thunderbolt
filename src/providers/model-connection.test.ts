/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, afterAll, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/database'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import {
  saveProviderConnection,
  updateProviderConnection,
  disconnectProviderConnection,
} from '@/dal/provider-connections'
import { getModel } from '@/dal/models'
import { providerConnectionsTable } from '@/db/tables'
import { addProviderModels } from './models'
import { bindModelProvider } from './model-connection'

beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)
const setup = async () => {
  const input = {
    provider: 'otari' as const,
    name: 'Work',
    url: 'https://otari.example/api/v1',
    authMethod: 'api_key' as const,
    credentials: { apiKey: 'original' },
  }
  const id = await saveProviderConnection(getDb(), input)
  const [modelId] = await addProviderModels(getDb(), id, [{ id: 'deepseek' }])
  const model = (await getModel(getDb(), modelId))!
  return { id, model, input }
}

it('uses the connection credential on every inference request', async () => {
  const { model } = await setup()
  const bound = await bindModelProvider(model)
  const send = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer original')
    return new Response('{}')
  })
  await bound.wrapFetch(Object.assign(send, { preconnect: async () => false }))(
    'https://otari.example/api/v1/chat/completions',
    {
      headers: { Authorization: 'Bearer stale' },
    },
  )
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(['disabled', 'disconnected', 'replaced', 'redirected'] as const)(
  'does not issue a stale inference request after a connection is %s',
  async (change) => {
    const { id, model, input } = await setup()
    const bound = await bindModelProvider(model)
    if (change === 'disabled') {
      await updateProviderConnection(getDb(), id, { enabled: false })
    }
    if (change === 'disconnected') {
      await disconnectProviderConnection(getDb(), id)
    }
    if (change === 'replaced') {
      await saveProviderConnection(getDb(), { ...input, id, credentials: { apiKey: 'replacement' } })
    }
    if (change === 'redirected') {
      await getDb()
        .update(providerConnectionsTable)
        .set({ url: 'https://other.example/api/v1' })
        .where(eq(providerConnectionsTable.id, id))
    }
    const send = mock(async () => new Response('{}'))
    await expect(
      bound.wrapFetch(Object.assign(send, { preconnect: async () => false }))(
        'https://otari.example/api/v1/chat/completions',
      ),
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  },
)

it('does not route a connection credential through another provider protocol', async () => {
  const { model } = await setup()
  await expect(bindModelProvider({ ...model, provider: 'openai' })).rejects.toThrow('provider connection changed')
})

it.each(['anthropic', 'custom'] as const)('uses the correct authentication headers for %s', async (provider) => {
  const id = await saveProviderConnection(getDb(), {
    provider,
    name: 'Test',
    authMethod: 'api_key',
    url: provider === 'custom' ? 'http://localhost:1234/v1' : null,
    credentials: provider === 'custom' ? {} : { apiKey: 'current-key' },
  })
  const [modelId] = await addProviderModels(getDb(), id, [{ id: 'test' }])
  const bound = await bindModelProvider((await getModel(getDb(), modelId))!)
  const send = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBe(provider === 'anthropic' ? 'current-key' : null)
    return new Response('{}')
  })
  const input = new Request(
    provider === 'custom' ? 'http://localhost:1234/v1/chat/completions' : 'https://api.anthropic.com/v1/messages',
    {
      headers:
        provider === 'custom'
          ? { Accept: 'application/json', Authorization: 'Bearer placeholder' }
          : { Accept: 'application/json', 'x-api-key': 'stale-key' },
    },
  )
  await bound.wrapFetch(Object.assign(send, { preconnect: async () => false }))(input)
  expect(send).toHaveBeenCalledTimes(1)
})
