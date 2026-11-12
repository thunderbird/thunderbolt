/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  disconnectProviderConnection,
  saveProviderConnection,
  updateProviderConnection,
} from '@/dal/provider-connections'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { ImageSupportInconclusiveError, probeImageSupport } from './image-support-probe'

type RecordedRequest = { url: string; init: RequestInit; body: { model: string; messages: [{ content: unknown }] } }

/** A proxy fetch that replies with the queued responses in order and records each request. */
const createFetch = (...responses: Response[]) => {
  const requests: RecordedRequest[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({ url: String(input), init, body: JSON.parse(String(init.body)) })
      const response = responses.shift()
      if (!response) {
        throw new Error('Unexpected probe request')
      }
      return response
    },
    { preconnect: async () => true },
  ) as FetchFn
  return { requests, getProxyFetch: () => fetch }
}

const completion = (message: { content?: string | null; reasoning_content?: string }) =>
  Response.json({ choices: [{ message }] })

const signal = new AbortController().signal

// A non-loopback custom endpoint goes through the (injected) proxy fetch.
const customModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'custom-1',
    name: 'My VLM',
    provider: 'custom',
    model: 'qwen-vl',
    url: 'https://llm.example.com/v1',
    apiKey: 'sk-test',
    ...overrides,
  }) as Model

describe('probeImageSupport', () => {
  it('reports support when the model names the image color', async () => {
    const { requests, getProxyFetch } = createFetch(completion({ content: 'Green.' }))

    expect(await probeImageSupport(customModel(), getProxyFetch, signal)).toBe('supported')

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request.url).toBe('https://llm.example.com/v1/chat/completions')
    expect(request.init.method).toBe('POST')
    expect(new Headers(request.init.headers).get('Authorization')).toBe('Bearer sk-test')
    expect(request.body).toMatchObject({ model: 'qwen-vl', stream: false })
    expect(request.body.messages[0].content).toContainEqual({
      type: 'image_url',
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    })
  })

  it('sends no Authorization header to a keyless endpoint', async () => {
    const { requests, getProxyFetch } = createFetch(completion({ content: 'green' }))
    await probeImageSupport(customModel({ apiKey: null }), getProxyFetch, signal)
    expect(new Headers(requests[0].init.headers).has('Authorization')).toBe(false)
  })

  it('ignores reasoning, where a text-only model can guess the color', async () => {
    const { getProxyFetch } = createFetch(completion({ content: '', reasoning_content: 'Maybe it is green?' }))
    await expect(probeImageSupport(customModel(), getProxyFetch, signal)).rejects.toBeInstanceOf(
      ImageSupportInconclusiveError,
    )
  })

  it('reports no support when the server accepts the image but the model never sees it', async () => {
    const { getProxyFetch } = createFetch(completion({ content: "I can't see images." }))
    expect(await probeImageSupport(customModel(), getProxyFetch, signal)).toBe('unsupported')
  })

  it('reports no support when the provider rejects the image but accepts plain text', async () => {
    const { requests, getProxyFetch } = createFetch(
      Response.json({ message: 'qwen is not a multimodal model' }, { status: 400 }),
      completion({ content: 'ok' }),
    )

    expect(await probeImageSupport(customModel(), getProxyFetch, signal)).toBe('unsupported')
    expect(requests).toHaveLength(2)
    expect(requests[1].body.messages[0].content).toBeTypeOf('string')
    // The caller's deadline covers both requests, capping how long the composer holds the send.
    expect(requests[0].init.signal).toBe(signal)
    expect(requests[1].init.signal).toBe(signal)
  })

  it('treats 415 and 422 rejections like a 400', async () => {
    for (const status of [415, 422]) {
      const { requests, getProxyFetch } = createFetch(new Response('', { status }), completion({ content: 'ok' }))
      expect(await probeImageSupport(customModel(), getProxyFetch, signal)).toBe('unsupported')
      expect(requests).toHaveLength(2)
    }
  })

  it('stays inconclusive when the provider rejects plain text too', async () => {
    const { getProxyFetch } = createFetch(new Response('', { status: 400 }), new Response('', { status: 400 }))
    await expect(probeImageSupport(customModel(), getProxyFetch, signal)).rejects.toBeInstanceOf(
      ImageSupportInconclusiveError,
    )
  })

  it('stays inconclusive on auth, rate-limit, and server errors without a follow-up request', async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const { requests, getProxyFetch } = createFetch(new Response('', { status }))
      await expect(probeImageSupport(customModel(), getProxyFetch, signal)).rejects.toBeInstanceOf(
        ImageSupportInconclusiveError,
      )
      expect(requests).toHaveLength(1)
    }
  })

  it('stays inconclusive when the completion carries no answer', async () => {
    const { getProxyFetch } = createFetch(completion({ content: null }))
    await expect(probeImageSupport(customModel(), getProxyFetch, signal)).rejects.toBeInstanceOf(
      ImageSupportInconclusiveError,
    )
  })

  describe('transport failures, which throw the underlying error (never cached either way)', () => {
    /** A proxy fetch built from a custom implementation. */
    const fetchFrom = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
      const fetch = Object.assign(impl, { preconnect: async () => true }) as FetchFn
      return () => fetch
    }

    it('lets a network error through', async () => {
      const getProxyFetch = fetchFrom(async () => {
        throw new TypeError('Failed to fetch')
      })
      await expect(probeImageSupport(customModel(), getProxyFetch, signal)).rejects.toBeInstanceOf(TypeError)
    })

    it('stops at the caller’s deadline', async () => {
      const getProxyFetch = fetchFrom(async (_input, init) => {
        init?.signal?.throwIfAborted()
        return completion({ content: 'green' })
      })
      const expired = AbortSignal.abort(new DOMException('The check took too long', 'TimeoutError'))
      await expect(probeImageSupport(customModel(), getProxyFetch, expired)).rejects.toMatchObject({
        name: 'TimeoutError',
      })
    })

    it('lets a reply that isn’t JSON through', async () => {
      const { getProxyFetch } = createFetch(new Response('<html>gateway error</html>', { status: 200 }))
      await expect(probeImageSupport(customModel(), getProxyFetch, signal)).rejects.toBeInstanceOf(SyntaxError)
    })
  })

  it('stays inconclusive without a request when the model has no OpenAI-compatible connection', async () => {
    const { requests, getProxyFetch } = createFetch()
    const keylessOpenAi = customModel({ provider: 'openai', url: null, apiKey: null })
    await expect(probeImageSupport(keylessOpenAi, getProxyFetch, signal)).rejects.toBeInstanceOf(
      ImageSupportInconclusiveError,
    )
    expect(requests).toHaveLength(0)
  })
})

describe('provider-connected image probes', () => {
  beforeEach(resetTestDatabase)
  afterAll(teardownTestDatabase)

  const setup = async () => {
    const input = {
      provider: 'custom' as const,
      name: 'Vision server',
      url: 'https://current.example/v1',
      authMethod: 'api_key' as const,
      credentials: { apiKey: 'current-key' },
    }
    const id = await saveProviderConnection(getDb(), input)
    return { input, id, model: customModel({ providerConnectionId: id }) }
  }

  it('resolves the current endpoint and credential instead of using the model snapshot', async () => {
    const { model } = await setup()
    const { requests, getProxyFetch } = createFetch(completion({ content: 'green' }))
    expect(await probeImageSupport(model, getProxyFetch, signal)).toBe('supported')
    expect(requests[0].url).toBe('https://current.example/v1/chat/completions')
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBe('Bearer current-key')
  })

  it.each(['disabled', 'disconnected'] as const)('does not probe a %s connection', async (change) => {
    const { id, model } = await setup()
    if (change === 'disabled') {
      await updateProviderConnection(getDb(), id, { enabled: false })
    } else {
      await disconnectProviderConnection(getDb(), id)
    }
    const { requests, getProxyFetch } = createFetch(completion({ content: 'green' }))
    await expect(probeImageSupport(model, getProxyFetch, signal)).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  it.each(['disconnected', 'replaced'] as const)(
    'does not send the control request after the connection is %s',
    async (change) => {
      const { input, id, model } = await setup()
      const send = mock(async () => {
        if (change === 'disconnected') {
          await disconnectProviderConnection(getDb(), id)
        } else {
          await saveProviderConnection(getDb(), { ...input, id, credentials: { apiKey: 'replacement-key' } })
        }
        return new Response('', { status: 400 })
      })
      const fetch = Object.assign(send, { preconnect: async () => true })
      await expect(probeImageSupport(model, () => fetch, signal)).rejects.toThrow()
      expect(send).toHaveBeenCalledTimes(1)
    },
  )
})
