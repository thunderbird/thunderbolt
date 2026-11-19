/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Regression guard for {@link buildOpenAiCompatModel}'s `withInjectedFetch` swap.
 *
 * The provider has no `fetch?` seam, so it routes every request through the app's
 * proxy fetch by SYNCHRONOUSLY swapping `globalThis.fetch` for the window in which
 * Pi's openai-completions API constructs its OpenAI SDK client (which captures the
 * global `fetch` at construction). This test pins that contract end to end:
 *
 *   - it sets `globalThis.fetch` to a SENTINEL that must never be hit, and
 *   - hands `buildOpenAiCompatModel` a distinct injected fetch,
 *
 * then drives a real `streamSimple` and asserts the HTTP went through the INJECTED
 * fetch while the sentinel stayed untouched, and that the global was restored
 * synchronously. If a future `openai`/`@earendil-works/pi-ai` bump makes fetch
 * resolution lazy (read at request time instead of captured at construction), the
 * request would fall through to the sentinel and this test fails loudly — catching
 * a silent proxy bypass that would otherwise leak requests past the CORS proxy.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { buildOpenAiCompatModel } from './openai-compat-model.ts'

/** A minimal, well-formed OpenAI Chat Completions SSE stream: one content delta
 *  then a stop, so the openai SDK parses a clean response rather than erroring. */
const sseBody = [
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
  '',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

const makeSseResponse = (): Response =>
  new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })

const context: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

describe('buildOpenAiCompatModel — withInjectedFetch', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('routes HTTP through the synchronously-injected fetch the SDK captured, not the global', async () => {
    let injectedCalls = 0
    let injectedUrl = ''
    const injectedFetch = async (input: RequestInfo | URL): Promise<Response> => {
      injectedCalls += 1
      injectedUrl = urlOf(input)
      return makeSseResponse()
    }

    let sentinelCalls = 0
    const sentinel = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      sentinelCalls += 1
      return new Response('', { status: 500 })
    }) as typeof globalThis.fetch
    globalThis.fetch = sentinel

    const { models, model } = buildOpenAiCompatModel({
      providerId: 'openai',
      modelId: 'gpt-test',
      baseURL: 'https://upstream.example/v1',
      apiKey: 'test-key',
      fetch: injectedFetch,
      reasoning: false,
      supportsImages: false,
    })

    const provider = models.getProvider('openai')
    if (!provider) {
      throw new Error('expected the openai provider to be registered')
    }

    // The OpenAI client is constructed synchronously inside this call, inside the
    // swap window — so the moment it returns, the global must already be restored.
    const stream = provider.streamSimple(model, context)
    expect(globalThis.fetch).toBe(sentinel)

    // The request itself fires lazily on iteration (global is the sentinel by now);
    // the captured injected fetch must still be what serves it.
    for await (const event of stream) {
      void event
    }

    expect(injectedCalls).toBe(1)
    expect(injectedUrl).toContain('upstream.example')
    expect(sentinelCalls).toBe(0)
  })
})

describe('buildOpenAiCompatModel — image modality', () => {
  const noopFetch = (async () => new Response('')) as Parameters<typeof buildOpenAiCompatModel>[0]['fetch']
  const build = (supportsImages: boolean) =>
    buildOpenAiCompatModel({
      providerId: 'thunderbolt',
      modelId: 'opus-4.8',
      baseURL: 'https://cloud.example/v1',
      apiKey: 'k',
      fetch: noopFetch,
      reasoning: false,
      supportsImages,
    }).model

  it('advertises image input when the model supports images, so Pi keeps image blocks', () => {
    expect(build(true).input).toEqual(['text', 'image'])
  })

  it('advertises text-only when the model does not support images', () => {
    expect(build(false).input).toEqual(['text'])
  })
})

describe('buildOpenAiCompatModel — CLI options', () => {
  const fetch = async (): Promise<Response> => new Response('')
  const options = {
    providerId: 'openai-compat',
    modelId: 'local-model',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'local-key',
    fetch,
    reasoning: false,
    supportsImages: false,
  }

  it('rejects a model that does not use OpenAI completions', () => {
    const { models, model } = buildOpenAiCompatModel(options)
    const provider = models.getProvider('openai-compat')
    if (!provider) {
      throw new Error('provider not registered')
    }
    const mismatched = { ...model, api: 'anthropic-messages' } as Model<Api>

    expect(() => provider.stream(mismatched, context)).toThrow(/Expected an "openai-completions" model/)
    expect(() => provider.streamSimple(mismatched, context)).toThrow(/got "anthropic-messages"/)
  })

  it('uses the configured API key for both provider entry points', async () => {
    const authorizationHeaders: (string | null)[] = []
    const authenticatedFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization'))
      return makeSseResponse()
    }
    const { models, model } = buildOpenAiCompatModel({ ...options, fetch: authenticatedFetch })
    const provider = models.getProvider('openai-compat')
    if (!provider) {
      throw new Error('provider not registered')
    }

    for await (const event of provider.stream(model, context, { apiKey: 'per-call-key' })) {
      void event
    }
    for await (const event of provider.streamSimple(model, context)) {
      void event
    }

    expect(authorizationHeaders).toEqual(['Bearer local-key', 'Bearer local-key'])
  })

  it('preserves GLM compatibility metadata so reasoning content streams', async () => {
    const glm = builtinModels().getModel('zai', 'glm-5.2')
    if (!glm) {
      throw new Error('GLM 5.2 metadata unavailable')
    }
    const payloads: { readonly reasoning_effort?: unknown; readonly thinking?: unknown }[] = []
    const reasoningBody = [
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thought"},"finish_reason":null}]}',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    const reasoningFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      payloads.push((await new Response(init?.body).json()) as (typeof payloads)[number])
      return new Response(reasoningBody, { headers: { 'content-type': 'text/event-stream' } })
    }
    const { models, model } = buildOpenAiCompatModel({
      ...options,
      modelId: 'glm-5.2',
      fetch: reasoningFetch,
      reasoning: true,
      compat: glm.compat,
      thinkingLevelMap: glm.thinkingLevelMap,
    })
    const provider = models.getProvider('openai-compat')
    if (!provider) {
      throw new Error('provider not registered')
    }
    const thinking: string[] = []

    for await (const event of provider.streamSimple(model, context, { reasoning: 'medium' })) {
      if (event.type === 'thinking_delta') {
        thinking.push(event.delta)
      }
    }

    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      reasoning_effort: 'high',
      thinking: { type: 'enabled', clear_thinking: false },
    })
    expect(thinking).toEqual(['thought'])
  })
})

it.each(['completed', 'failed', 'interrupted'] as const)(
  'routes Responses API calls through injected fetch and handles %s streams',
  async (outcome) => {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    const events =
      outcome === 'completed'
        ? [
            {
              type: 'response.completed',
              response: {
                id: 'r',
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            },
          ]
        : outcome === 'failed'
          ? [
              {
                type: 'response.failed',
                response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached' } },
              },
            ]
          : []
    const { models, model } = buildOpenAiCompatModel({
      api: 'openai-responses',
      getReasoningEffort: () => 'high',
      providerId: 'openai',
      modelId: 'gpt-test',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'access',
      reasoning: false,
      supportsImages: false,
      fetch: async (input, init) => {
        requests.push({ url: urlOf(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    })
    const provider = models.getProvider('openai')!
    const stream = provider.streamSimple(model, context)
    const result = await stream.result()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/responses')
    expect(requests[0]?.body).toMatchObject({ stream: true, store: false, reasoning: { effort: 'high' } })
    expect(requests[0]?.body).not.toHaveProperty('reasoning_effort')
    expect(result.stopReason).toBe(outcome === 'completed' ? 'stop' : 'error')
  },
)
describe('explicit reasoning effort', () => {
  it.each(['openai', 'openrouter', 'tinfoil'] as const)(
    'writes exact %s payloads and restores the original profile on Default',
    async (format) => {
      const payloads: Array<Record<string, unknown>> = []
      const preference: { value: import('../reasoning-effort.ts').ReasoningEffort | undefined } = { value: 'high' }
      const { models, model } = buildOpenAiCompatModel({
        providerId: format,
        modelId: 'test',
        apiKey: 'test',
        baseURL: 'https://test.invalid/v1',
        reasoning: false,
        supportsImages: false,
        effortFormat: format,
        getReasoningEffort: () => preference.value,
        fetch: async (_input, init) => {
          payloads.push(JSON.parse(String(init?.body)))
          return makeSseResponse()
        },
      })
      const provider = models.getProvider(format)!
      for (const value of ['high', 'none', undefined] as const) {
        preference.value = value
        await provider
          .streamSimple(model, context, {
            onPayload: (payload) => ({ ...(payload as object), test_marker: 'preserved' }),
          })
          .result()
      }
      expect(payloads.map((payload) => payload.test_marker)).toEqual(['preserved', 'preserved', 'preserved'])
      const field = format === 'openrouter' ? 'reasoning' : 'reasoning_effort'
      expect(payloads.map((payload) => payload[field])).toEqual(
        format === 'openrouter' ? [{ effort: 'high' }, { effort: 'none' }, undefined] : ['high', 'none', undefined],
      )
    },
  )
})
