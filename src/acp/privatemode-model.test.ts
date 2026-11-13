/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { saveProviderConnection } from '@/dal/provider-connections'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import * as privatemodeClients from '@/ai/privatemode-client'
import type { AgentAdapterContext } from '@/types/acp'
import { resolvePiModel, harnessSignature } from './built-in-adapter'
import { isPiModelCandidate } from './built-in-model-support'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

it('routes even tool-disabled Privatemode models exclusively through the attested SDK transport', async () => {
  const id = await saveProviderConnection(getDb(), {
    provider: 'privatemode',
    name: 'Private inference',
    authMethod: 'api_key',
    credentials: { apiKey: 'pm-live-key' },
  })
  const model = createMockModel({
    provider: 'privatemode',
    model: 'glm-5.3',
    isSystem: 0,
    isConfidential: 1,
    providerConnectionId: id,
    apiKey: 'stale-key',
    toolUsage: 0,
  })
  const send = mock(async () => new Response('data: [DONE]\n\n'))
  const client = {
    baseURL: 'https://api.privatemode.ai/v1',
    fetch: send,
    ensureVerified: async () => {},
    close: () => {},
  }
  const acquire = spyOn(privatemodeClients, 'getPrivatemodeClient').mockResolvedValue(client)
  const proxy = mock(() => {
    throw new Error('Unattested proxy must never be used')
  })
  const context = { selectedModel: model, getProxyFetch: proxy } as unknown as AgentAdapterContext
  try {
    expect(isPiModelCandidate(model)).toBe(true)
    const resolved = await resolvePiModel({} as Parameters<typeof resolvePiModel>[0], context, null)
    expect(acquire).toHaveBeenCalledWith({ apiKey: 'pm-live-key', connectionId: id })
    expect(resolved?.descriptor.kind).toBe('openai-compat')
    if (!resolved || resolved.descriptor.kind !== 'openai-compat') {
      throw new Error('Missing confidential descriptor')
    }
    expect(resolved.attestedClient).toBe(client)
    await resolved.descriptor.fetch(`${client.baseURL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: model.model, messages: [], stream: true }),
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(proxy).not.toHaveBeenCalled()
    const signature = harnessSignature(resolved, 'system')
    expect(harnessSignature({ ...resolved, attestedClient: { ...client } }, 'system')).not.toBe(signature)
    await saveProviderConnection(getDb(), {
      id,
      provider: 'privatemode',
      name: 'Private inference',
      authMethod: 'api_key',
      credentials: { apiKey: 'rotated-key' },
    })
    await expect(resolved.descriptor.fetch(`${client.baseURL}/chat/completions`, { method: 'POST' })).rejects.toThrow(
      'changed',
    )
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    acquire.mockRestore()
  }
})

it('does not fall back to an ordinary connection when attestation fails', async () => {
  const failure = new Error('Privatemode attestation rejected')
  const acquire = spyOn(privatemodeClients, 'getPrivatemodeClient').mockRejectedValue(failure)
  const proxy = mock(() => {
    throw new Error('Unattested proxy must never be used')
  })
  const context = {
    selectedModel: createMockModel({ provider: 'privatemode', apiKey: 'pm-key', isSystem: 0 }),
    getProxyFetch: proxy,
  } as unknown as AgentAdapterContext
  try {
    await expect(resolvePiModel({} as Parameters<typeof resolvePiModel>[0], context, null)).rejects.toBe(failure)
    expect(proxy).not.toHaveBeenCalled()
  } finally {
    acquire.mockRestore()
  }
})
