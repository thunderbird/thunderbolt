/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createModel } from '@/ai/fetch'
import { getDb } from '@/db/database'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import {
  disconnectProviderConnection,
  saveProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import type { FetchFn } from '@/lib/proxy-fetch'
import { APICallError } from 'ai'
import { createDefaultProbe } from './use-model-connection-test'

const proxyFetch: FetchFn = Object.assign(async () => new Response(), {
  preconnect: () => Promise.resolve(false),
})

const completionResponse = (): Response =>
  Response.json({
    id: 'completion-id',
    object: 'chat.completion',
    created: 1,
    model: 'glm-5-3',
    choices: [{ index: 0, message: { role: 'assistant', content: 'test successful' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  })

describe('createDefaultProbe', () => {
  it('tests a BYOK Tinfoil model through one attested chat completion', async () => {
    const requests: Request[] = []
    const client = {
      getBaseURL: () => 'https://enclave.example.com/v1',
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        expect(this).toBe(client)
        requests.push(input instanceof Request ? input : new Request(input, init))
        return completionResponse()
      },
    }
    const getTinfoilClient = mock(async () => client as never)
    const createAiModel = mock(async () => {
      throw new Error('Non-Tinfoil factory must not be called')
    })
    const probe = createDefaultProbe({ getTinfoilClient, createModel: createAiModel as never })

    await probe(
      { provider: 'tinfoil', model: 'glm-5-3', url: null, apiKey: 'user-key' },
      () => proxyFetch,
      new AbortController().signal,
    )

    expect(getTinfoilClient).toHaveBeenCalledTimes(1)
    expect(getTinfoilClient).toHaveBeenCalledWith()
    expect(createAiModel).toHaveBeenCalledTimes(0)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://enclave.example.com/v1/chat/completions')
    expect(requests[0].method).toBe('POST')
    expect(requests[0].headers.get('authorization')).toBe('Bearer user-key')
  })

  it('rejects a keyless Tinfoil model before acquiring a client', async () => {
    const getTinfoilClient = mock(async () => {
      throw new Error('Client acquisition must not start')
    })
    const probe = createDefaultProbe({ getTinfoilClient })

    await expect(
      probe(
        { provider: 'tinfoil', model: 'glm-5-3', url: null, apiKey: null },
        () => proxyFetch,
        new AbortController().signal,
      ),
    ).rejects.toThrow('No API key provided')
    expect(getTinfoilClient).toHaveBeenCalledTimes(0)
  })

  it('keeps non-Tinfoil providers on the shared model factory', async () => {
    const aiModel = { id: 'model' }
    const createAiModel = mock(async () => aiModel as never)
    const runGenerateText = mock(async () => ({ text: 'test successful' }))
    const getTinfoilClient = mock(async () => {
      throw new Error('Tinfoil client must not be acquired')
    })
    const probe = createDefaultProbe({
      createModel: createAiModel as never,
      generateText: runGenerateText as never,
      getTinfoilClient,
    })

    await probe(
      { provider: 'openai', model: 'gpt-5', url: null, apiKey: 'openai-key' },
      () => proxyFetch,
      new AbortController().signal,
    )

    expect(createAiModel).toHaveBeenCalledTimes(1)
    expect(runGenerateText).toHaveBeenCalledWith({
      model: aiModel,
      prompt: 'Say "test successful" if you can read this.',
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
      tools: { get_current_time: expect.anything() },
    })
    expect(getTinfoilClient).toHaveBeenCalledTimes(0)
  })
})

describe('createDefaultProbe provider connection binding', () => {
  beforeEach(resetTestDatabase)
  afterAll(teardownTestDatabase)

  /** Deliberately stale model fields must never override the linked account. */
  const linkedConfig = async (provider: 'openrouter' | 'tinfoil') => ({
    providerConnectionId: await saveProviderConnection(getDb(), {
      provider,
      name: 'Work',
      authMethod: 'api_key',
      credentials: { apiKey: 'current-key' },
    }),
    provider,
    model: 'test-model',
    url: null,
    apiKey: 'stale-model-key',
  })

  it('keeps the connection ID through the shared factory and uses its current credential', async () => {
    const config = await linkedConfig('openrouter')
    const send = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer current-key')
      return completionResponse()
    })
    const probe = createDefaultProbe()
    expect(
      await probe(config, () => Object.assign(send, { preconnect: async () => false }), new AbortController().signal),
    ).toBe('supported')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not send a shared-factory probe after the connection is disabled during setup', async () => {
    const config = await linkedConfig('openrouter')
    const send = mock(async () => completionResponse())
    const probe = createDefaultProbe({
      createModel: async (model, getFetch) => {
        const aiModel = await createModel(model, getFetch)
        await updateProviderConnection(getDb(), config.providerConnectionId, { enabled: false })
        return aiModel
      },
    })
    await expect(
      probe(config, () => Object.assign(send, { preconnect: async () => false }), new AbortController().signal),
    ).rejects.toThrow('Connect this provider on this device')
    expect(send).not.toHaveBeenCalled()
  })

  it('uses the linked Tinfoil credential over the attested transport', async () => {
    const config = await linkedConfig('tinfoil')
    const send = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer current-key')
      return completionResponse()
    })
    const probe = createDefaultProbe({
      getTinfoilClient: async () => ({ getBaseURL: () => 'https://enclave.example.com/v1', fetch: send }) as never,
    })
    expect(await probe(config, () => proxyFetch, new AbortController().signal)).toBe('supported')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(['disabled', 'disconnected', 'replaced'] as const)(
    'does not send a Tinfoil probe when its connection is %s during attestation',
    async (change) => {
      const config = await linkedConfig('tinfoil')
      const send = mock(async () => completionResponse())
      const probe = createDefaultProbe({
        getTinfoilClient: async () => {
          if (change === 'disabled') {
            await updateProviderConnection(getDb(), config.providerConnectionId, { enabled: false })
          } else if (change === 'disconnected') {
            await disconnectProviderConnection(getDb(), config.providerConnectionId)
          } else {
            await saveProviderConnection(getDb(), {
              id: config.providerConnectionId,
              provider: 'tinfoil',
              name: 'Replacement',
              authMethod: 'api_key',
              credentials: { apiKey: 'replacement' },
            })
          }
          return { getBaseURL: () => 'https://enclave.example.com/v1', fetch: send } as never
        },
      })
      await expect(probe(config, () => proxyFetch, new AbortController().signal)).rejects.toThrow()
      expect(send).not.toHaveBeenCalled()
    },
  )

  it('rechecks Tinfoil before retrying a tool rejection without tools', async () => {
    const config = await linkedConfig('tinfoil')
    const send = mock(async () => {
      await disconnectProviderConnection(getDb(), config.providerConnectionId)
      return Response.json({ error: { message: 'Tools unsupported' } }, { status: 400 })
    })
    const probe = createDefaultProbe({
      getTinfoilClient: async () => ({ getBaseURL: () => 'https://enclave.example.com/v1', fetch: send }) as never,
    })
    await expect(probe(config, () => proxyFetch, new AbortController().signal)).rejects.toThrow(
      'Connect this provider on this device',
    )
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects a different provider identity before acquiring the Tinfoil client', async () => {
    const config = await linkedConfig('openrouter')
    const getTinfoilClient = mock(async () => {
      throw new Error('Must not attest')
    })
    const probe = createDefaultProbe({ getTinfoilClient })
    await expect(
      probe({ ...config, provider: 'tinfoil' }, () => proxyFetch, new AbortController().signal),
    ).rejects.toThrow('The model provider connection changed')
    expect(getTinfoilClient).not.toHaveBeenCalled()
  })
})

const apiCallError = (statusCode: number) =>
  new APICallError({
    message: `status ${statusCode}`,
    url: 'http://localhost:11434/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
  })

/** A probe over a stubbed model whose `generateText` answers each call in turn. */
const probeWith = (...outcomes: Array<Error | 'ok'>) => {
  const calls: Array<Record<string, unknown>> = []
  const runGenerateText = mock(async (options: Record<string, unknown>) => {
    calls.push(options)
    const outcome = outcomes[calls.length - 1]
    if (outcome instanceof Error) {
      throw outcome
    }
    return { text: 'test successful' }
  })
  const probe = createDefaultProbe({
    createModel: mock(async () => ({ id: 'model' }) as never) as never,
    generateText: runGenerateText as never,
  })
  const run = () =>
    probe(
      { provider: 'custom', model: 'gemma3:4b', url: 'http://localhost:11434/v1', apiKey: null },
      () => proxyFetch,
      new AbortController().signal,
    )
  return { run, calls }
}

describe('createDefaultProbe tool support', () => {
  it('reports tools as supported when the tools request succeeds', async () => {
    const { run, calls } = probeWith('ok')

    expect(await run()).toBe('supported')
    expect(calls).toHaveLength(1)
    expect(calls[0].tools).toBeDefined()
  })

  it.each([400, 404, 422])(
    'reports tools as unsupported when a %i tools request is followed by a plain success',
    async (statusCode) => {
      const { run, calls } = probeWith(apiCallError(statusCode), 'ok')

      expect(await run()).toBe('unsupported')
      expect(calls).toHaveLength(2)
      expect(calls[1].tools).toBeUndefined()
    },
  )

  it.each([500, 503])('reports tools as unsupported when a %i tools request fails twice', async (statusCode) => {
    const { run, calls } = probeWith(apiCallError(statusCode), 'ok', apiCallError(statusCode))

    expect(await run()).toBe('unsupported')
    expect(calls).toHaveLength(3)
    expect(calls[1].tools).toBeUndefined()
    expect(calls[2].tools).toBeDefined()
  })

  it.each([401, 429])('fails instead of turning tools off when the 5xx confirmation hits a %i', async (statusCode) => {
    const { run, calls } = probeWith(apiCallError(503), 'ok', apiCallError(statusCode))

    await expect(run()).rejects.toThrow(`status ${statusCode}`)
    expect(calls).toHaveLength(3)
  })

  it('fails instead of turning tools off when the 5xx confirmation loses its connection', async () => {
    const { run } = probeWith(apiCallError(503), 'ok', new TypeError('Failed to fetch'))

    await expect(run()).rejects.toThrow('Failed to fetch')
  })

  it('reports tools as supported when a 5xx tools request succeeds on the second try', async () => {
    const { run, calls } = probeWith(apiCallError(503), 'ok', 'ok')

    expect(await run()).toBe('supported')
    expect(calls).toHaveLength(3)
  })

  it('fails with the plain request error when both requests fail', async () => {
    const { run, calls } = probeWith(apiCallError(400), apiCallError(404))

    await expect(run()).rejects.toThrow('status 404')
    expect(calls).toHaveLength(2)
  })

  it.each([401, 403, 408, 429])(
    'fails without retrying on a %i, which says nothing about tools',
    async (statusCode) => {
      const { run, calls } = probeWith(apiCallError(statusCode), 'ok')

      await expect(run()).rejects.toThrow(`status ${statusCode}`)
      expect(calls).toHaveLength(1)
    },
  )

  it('fails without retrying on a network error', async () => {
    const { run, calls } = probeWith(new TypeError('Failed to fetch'), 'ok')

    await expect(run()).rejects.toThrow('Failed to fetch')
    expect(calls).toHaveLength(1)
  })
})
