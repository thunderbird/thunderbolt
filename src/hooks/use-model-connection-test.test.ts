/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { FetchFn } from '@/lib/proxy-fetch'
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
    })
    expect(getTinfoilClient).toHaveBeenCalledTimes(0)
  })
})
