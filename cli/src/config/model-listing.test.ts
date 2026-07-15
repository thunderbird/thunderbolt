/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { listModels } from './model-listing.ts'
import type { ModelListingFetch } from './model-listing.ts'

describe('listModels', () => {
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

    expect(result).toEqual({ source: 'live', ids: ['gpt-live-a', 'gpt-live-b'] })
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

    expect(result).toEqual({ source: 'live', ids: ['claude-live-a', 'claude-live-b'] })
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

    expect(result).toEqual({ source: 'live', ids: ['gemini-live-chat'] })
    expect(String(requests[0]?.input)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key',
    )
    expect(new Headers(requests[0]?.init?.headers).has('Authorization')).toBe(false)
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
    })
  })

  test('sorts by created descending and limits live suggestions to eight', async () => {
    const fetchFn: ModelListingFetch = async () =>
      Response.json({
        data: Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, created: index })),
      })

    expect(await listModels({ provider: 'groq', apiKey: 'key', fetchFn })).toEqual({
      source: 'live',
      ids: ['model-9', 'model-8', 'model-7', 'model-6', 'model-5', 'model-4', 'model-3', 'model-2'],
    })
  })

  test('derives compatible listing routes from Pi descriptors', async () => {
    const urls: string[] = []
    const fetchFn: ModelListingFetch = async (input) => {
      urls.push(String(input))
      return Response.json({ data: [{ id: 'chat-model' }] })
    }

    for (const provider of [
      'xai',
      'deepseek',
      'zai',
      'mistral',
      'groq',
      'openrouter',
      'moonshotai',
      'minimax',
      'cerebras',
      'together',
      'fireworks',
    ] as const) {
      await listModels({ provider, apiKey: 'key', fetchFn })
    }

    expect(urls).toEqual([
      'https://api.x.ai/v1/models',
      'https://api.deepseek.com/models',
      'https://api.z.ai/api/coding/paas/v4/models',
      'https://api.mistral.ai/v1/models',
      'https://api.groq.com/openai/v1/models',
      'https://openrouter.ai/api/v1/models',
      'https://api.moonshot.ai/v1/models',
      'https://api.minimax.io/v1/models',
      'https://api.cerebras.ai/v1/models',
      'https://api.together.ai/v1/models',
      'https://api.fireworks.ai/inference/v1/models',
    ])
  })

  test('returns catalog models on timeout even when injected fetch ignores abort', async () => {
    const fetchFn: ModelListingFetch = async () => new Promise<Response>(() => {})

    expect(await listModels({ provider: 'openai', apiKey: 'key', fetchFn, timeoutMs: 1 })).toEqual({
      source: 'catalog',
      ids: ['gpt-4', 'gpt-4-turbo', 'gpt-4.1'],
    })
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

    expect(unavailable).toEqual({ source: 'catalog', ids: ['gpt-4', 'gpt-4-turbo', 'gpt-4.1'] })
    expect(malformed).toEqual({ source: 'catalog', ids: ['gpt-4', 'gpt-4-turbo', 'gpt-4.1'] })
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

    expect(unauthorized).toEqual({
      source: 'catalog',
      ids: ['gpt-4', 'gpt-4-turbo', 'gpt-4.1'],
      authRejected: true,
      status: 401,
    })
    expect(forbidden).toEqual({
      source: 'catalog',
      ids: ['gpt-4', 'gpt-4-turbo', 'gpt-4.1'],
      authRejected: true,
      status: 403,
    })
  })

  test('treats an empty chat-capable result as catalog fallback', async () => {
    const result = await listModels({
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'local',
      fetchFn: async () => Response.json({ data: [{ id: 'nomic-embed-text' }] }),
    })

    expect(result).toEqual({ source: 'catalog', ids: [] })
  })
})
