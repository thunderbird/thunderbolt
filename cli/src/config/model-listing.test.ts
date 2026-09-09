/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, test } from 'bun:test'
import { listModels, validateModelListingBaseUrl } from './model-listing.ts'
import type { ModelListingFetch } from './model-listing.ts'

/** Derives fallback expectations from Pi's wired catalog so catalog churn does not break behavior tests. */
const openAiCatalogIds = builtinModels()
  .getModels('openai')
  .slice(0, 3)
  .map(({ id }) => id)

describe('listModels', () => {
  test('rejects insecure or unpinned built-in descriptor URLs before credentials are used', () => {
    expect(() => validateModelListingBaseUrl('openai', 'http://provider.example/v1')).toThrow('https')
    expect(() => validateModelListingBaseUrl('openai', 'https://credential-sink.example/v1')).toThrow(/origin/i)
  })

  test('reads an OpenAI-compatible model list with bearer authentication', async () => {
    const requests: { readonly input: string | URL | Request; readonly init?: RequestInit }[] = []
    const fetchFn: ModelListingFetch = async (input, init) => {
      requests.push({ input, init })
      return Response.json({
        object: 'list',
        data: [
          { id: 'gpt-live-a', object: 'model' },
          { id: 'gpt-live-b', object: 'model' },
        ],
      })
    }

    const result = await listModels({ provider: 'openai', apiKey: 'secret-key', fetchFn })

    expect(result).toEqual({ source: 'live', ids: ['gpt-live-a', 'gpt-live-b'], authenticated: true })
    expect(String(requests[0]?.input)).toBe('https://api.openai.com/v1/models')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer secret-key')
  })

  test('reads Anthropic models with Anthropic authentication headers', async () => {
    const requests: { readonly input: string | URL | Request; readonly init?: RequestInit }[] = []
    const fetchFn: ModelListingFetch = async (input, init) => {
      requests.push({ input, init })
      return Response.json({
        data: [
          { id: 'claude-live-b', type: 'model', created_at: '2026-06-01T00:00:00Z' },
          { id: 'claude-live-a', type: 'model', created_at: '2026-07-01T00:00:00Z' },
        ],
      })
    }

    const result = await listModels({ provider: 'anthropic', apiKey: 'anthropic-key', fetchFn })

    expect(result).toEqual({ source: 'live', ids: ['claude-live-a', 'claude-live-b'], authenticated: true })
    expect(String(requests[0]?.input)).toBe('https://api.anthropic.com/v1/models')
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get('x-api-key')).toBe('anthropic-key')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.has('Authorization')).toBe(false)
  })

  test('reads only Gemini models supporting generateContent and strips their prefix', async () => {
    const requests: { readonly input: string | URL | Request; readonly init?: RequestInit }[] = []
    const fetchFn: ModelListingFetch = async (input, init) => {
      requests.push({ input, init })
      return Response.json({
        models: [
          { name: 'models/gemini-live-chat', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-no-chat', supportedGenerationMethods: ['countTokens'] },
        ],
      })
    }

    const result = await listModels({ provider: 'google', apiKey: 'gemini-key', fetchFn })

    expect(result).toEqual({ source: 'live', ids: ['gemini-live-chat'], authenticated: true })
    // The key must ride in the header, never the URL, so it can't land in proxy logs.
    expect(String(requests[0]?.input)).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(new Headers(requests[0]?.init?.headers).get('x-goog-api-key')).toBe('gemini-key')
    expect(new Headers(requests[0]?.init?.headers).has('Authorization')).toBe(false)
  })

  test('uses xAI language-model listing instead of mixed-modality models', async () => {
    const requests: { readonly input: string | URL | Request; readonly init?: RequestInit }[] = []
    const fetchFn: ModelListingFetch = async (input, init) => {
      requests.push({ input, init })
      return Response.json({
        models: [
          { id: 'grok-live-a', created: 2 },
          { id: 'grok-live-b', created: 1 },
        ],
      })
    }

    const result = await listModels({ provider: 'xai', apiKey: 'xai-key', fetchFn })

    expect(result).toEqual({ source: 'live', ids: ['grok-live-a', 'grok-live-b'], authenticated: true })
    expect(String(requests[0]?.input)).toBe('https://api.x.ai/v1/language-models')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer xai-key')
  })

  test('reads Together bare-array model responses', async () => {
    const requests: { readonly input: string | URL | Request; readonly init?: RequestInit }[] = []
    const result = await listModels({
      provider: 'together',
      apiKey: 'together-key',
      fetchFn: async (input, init) => {
        requests.push({ input, init })
        return Response.json([
          { id: 'chat-model', type: 'chat', created: 2 },
          { id: 'embedding-model', type: 'embedding', created: 1 },
        ])
      },
    })

    expect(result).toEqual({ source: 'live', ids: ['chat-model'], authenticated: true })
    expect(String(requests[0]?.input)).toBe('https://api.together.ai/v1/models')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer together-key')
  })

  test('filters non-chat model id patterns from compatible responses', async () => {
    const fetchFn: ModelListingFetch = async () =>
      Response.json({
        data: [
          { id: 'chat-model' },
          { id: 'text-embedding-3-large' },
          { id: 'whisper-large-v3' },
          { id: 'gpt-4o-mini-tts' },
          { id: 'dall-e-3' },
          { id: 'gpt-image-1' },
          { id: 'sora-2' },
          { id: 'omni-moderation-latest' },
          { id: 'cohere-rerank-v3' },
        ],
      })

    expect(await listModels({ provider: 'openrouter', apiKey: 'key', fetchFn })).toEqual({
      source: 'live',
      ids: ['chat-model'],
      authenticated: true,
    })
  })

  test('sorts by created descending without truncating live suggestions', async () => {
    const fetchFn: ModelListingFetch = async () =>
      Response.json({
        data: Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, created: index })),
      })

    expect(await listModels({ provider: 'groq', apiKey: 'key', fetchFn })).toEqual({
      source: 'live',
      ids: [
        'model-9',
        'model-8',
        'model-7',
        'model-6',
        'model-5',
        'model-4',
        'model-3',
        'model-2',
        'model-1',
        'model-0',
      ],
      authenticated: true,
    })
  })

  test('derives compatible listing routes from Pi descriptors', async () => {
    const urls: string[] = []
    const authorizations: (string | null)[] = []
    const fetchFn: ModelListingFetch = async (input, init) => {
      urls.push(String(input))
      authorizations.push(new Headers(init?.headers).get('Authorization'))
      return Response.json({ data: [{ id: 'chat-model' }] })
    }

    for (const provider of [
      'deepseek',
      'mistral',
      'groq',
      'openrouter',
      'moonshotai',
      'minimax',
      'cerebras',
    ] as const) {
      await listModels({ provider, apiKey: 'key', fetchFn })
    }

    expect(urls).toEqual([
      'https://api.deepseek.com/models',
      'https://api.mistral.ai/v1/models',
      'https://api.groq.com/openai/v1/models',
      'https://openrouter.ai/api/v1/models',
      'https://api.moonshot.ai/v1/models',
      'https://api.minimax.io/v1/models',
      'https://api.cerebras.ai/v1/models',
    ])
    expect(authorizations).toEqual(Array.from({ length: 7 }, () => 'Bearer key'))
  })

  test('uses catalog fallback without network calls when official docs expose no usable list route', async () => {
    const requestedProviders: string[] = []
    const fetchFn: ModelListingFetch = async (input) => {
      requestedProviders.push(String(input))
      return Response.json({ data: [{ id: 'unexpected-live-model' }] })
    }

    const zai = await listModels({ provider: 'zai', apiKey: 'key', fetchFn })
    const fireworks = await listModels({ provider: 'fireworks', apiKey: 'key', fetchFn })

    expect(zai.source).toBe('catalog')
    expect(zai.authenticated).toBe(false)
    expect(fireworks.source).toBe('catalog')
    expect(fireworks.authenticated).toBe(false)
    expect(requestedProviders).toEqual([])
  })

  test('returns catalog models on timeout', async () => {
    const fetchFn: ModelListingFetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    const result = await listModels({ provider: 'openai', apiKey: 'key', fetchFn, timeoutMs: 1 })

    expect(result.source).toBe('catalog')
    expect(result.authenticated).toBe(false)
    expect(result.ids).toEqual(openAiCatalogIds)
  })

  test('combines caller cancellation with the model-listing timeout', async () => {
    const controller = new AbortController()
    const cancellation = new Error('setup cancelled')
    const fetchFn: ModelListingFetch = async (_input, init) => {
      controller.abort(cancellation)
      init?.signal?.throwIfAborted()
      return Response.json({ data: [{ id: 'must-not-be-returned' }] })
    }

    await expect(
      listModels({ provider: 'openai', apiKey: 'key', fetchFn, timeoutMs: 60_000 }, controller.signal),
    ).rejects.toBe(cancellation)
  })

  test('returns catalog models when fetch rejects with a network TypeError', async () => {
    const fetchFn: ModelListingFetch = async () => {
      throw new TypeError('Network request failed.')
    }

    const result = await listModels({ provider: 'openai', apiKey: 'key', fetchFn })

    expect(result.source).toBe('catalog')
    expect(result.authenticated).toBe(false)
    expect(result.ids).toEqual(openAiCatalogIds)
  })

  test('returns catalog models when response JSON is invalid', async () => {
    const fetchFn: ModelListingFetch = async () =>
      new Response('{"data":', { headers: { 'Content-Type': 'application/json' } })

    const result = await listModels({ provider: 'openai', apiKey: 'key', fetchFn })

    expect(result.source).toBe('catalog')
    expect(result.authenticated).toBe(false)
    expect(result.ids).toEqual(openAiCatalogIds)
  })

  test('returns catalog models for non-success and malformed responses', async () => {
    const unavailable = await listModels({
      provider: 'openai',
      apiKey: 'key',
      fetchFn: async () => new Response('unavailable', { status: 503 }),
    })
    const malformed = await listModels({
      provider: 'openai',
      apiKey: 'key',
      fetchFn: async () => Response.json({ unexpected: [] }),
    })

    expect(unavailable.source).toBe('catalog')
    expect(unavailable.authenticated).toBe(false)
    expect(unavailable.ids).toEqual(openAiCatalogIds)
    expect(malformed.source).toBe('catalog')
    expect(malformed.authenticated).toBe(false)
    expect(malformed.ids).toEqual(openAiCatalogIds)
  })

  test('treats unrecognized provider responses as empty model lists', async () => {
    const providerResponses = [
      ['openai', { data: [{ broken: true }] }],
      ['google', { models: [{ broken: true }] }],
      ['xai', { models: [{ broken: true }] }],
      ['together', [{ broken: true }]],
    ] as const

    for (const [provider, response] of providerResponses) {
      const result = await listModels({
        provider,
        apiKey: 'key',
        fetchFn: async () => Response.json(response),
      })

      expect(result.source).toBe('catalog')
    }
  })

  test('propagates unexpected errors from model post-processing', async () => {
    const unexpectedError = new Error('Unexpected post-processing failure.')
    const parsed = new Proxy<Record<string, unknown>>(
      {},
      {
        get: () => {
          throw unexpectedError
        },
      },
    )
    class PostProcessingResponse extends Response {
      override readonly json = async (): Promise<unknown> => parsed
    }

    await expect(
      listModels({ provider: 'openai', apiKey: 'key', fetchFn: async () => new PostProcessingResponse() }),
    ).rejects.toBe(unexpectedError)
  })

  test('marks 401 and 403 catalog fallbacks as authentication rejections', async () => {
    const unauthorized = await listModels({
      provider: 'openai',
      apiKey: 'bad-key',
      fetchFn: async () => new Response(null, { status: 401 }),
    })
    const forbidden = await listModels({
      provider: 'openai',
      apiKey: 'bad-key',
      fetchFn: async () => new Response(null, { status: 403 }),
    })

    expect(unauthorized.source).toBe('catalog')
    expect(unauthorized.ids).toEqual(openAiCatalogIds)
    expect(unauthorized.wasAuthRejected).toBe(true)
    expect(unauthorized.status).toBe(401)
    expect(forbidden.source).toBe('catalog')
    expect(forbidden.ids).toEqual(openAiCatalogIds)
    expect(forbidden.wasAuthRejected).toBe(true)
    expect(forbidden.status).toBe(403)
  })

  test('treats an empty chat-capable result as catalog fallback', async () => {
    const urls: string[] = []
    const authorizations: (string | null)[] = []
    const result = await listModels({
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'local',
      fetchFn: async (input, init) => {
        urls.push(String(input))
        authorizations.push(new Headers(init?.headers).get('Authorization'))
        return Response.json({ data: [{ id: 'nomic-embed-text' }] })
      },
    })

    expect(result).toEqual({ source: 'catalog', ids: [], authenticated: true })
    expect(urls).toEqual(['http://localhost:11434/v1/models'])
    expect(authorizations).toEqual(['Bearer local'])
  })

  test('refuses to send a compatible API key to a remote cleartext endpoint', async () => {
    let requests = 0

    await expect(
      listModels({
        provider: 'openai-compat',
        baseUrl: 'http://models.example/v1',
        apiKey: 'must-not-leak',
        fetchFn: async () => {
          requests += 1
          return Response.json({ data: [] })
        },
      }),
    ).rejects.toThrow('https')
    expect(requests).toBe(0)
  })

  test('blocks a cross-origin redirect before the BYOK bearer can reach the target', async () => {
    const targetAuthorizations: (string | null)[] = []
    const target = Bun.serve({
      port: 0,
      fetch: (request) => {
        targetAuthorizations.push(request.headers.get('authorization'))
        return Response.json({ data: [{ id: 'stolen-model' }] })
      },
    })
    const sourceAuthorizations: (string | null)[] = []
    const source = Bun.serve({
      port: 0,
      fetch: (request) => {
        sourceAuthorizations.push(request.headers.get('authorization'))
        return Response.redirect(`http://127.0.0.1:${target.port}/models`, 302)
      },
    })

    try {
      const result = await listModels({
        provider: 'openai-compat',
        baseUrl: `http://127.0.0.1:${source.port}/v1`,
        apiKey: 'redirect-secret',
      })

      expect(result.authenticated).toBe(false)
      expect(sourceAuthorizations).toEqual(['Bearer redirect-secret'])
      expect(targetAuthorizations).toEqual([])
    } finally {
      source.stop(true)
      target.stop(true)
    }
  })
})
