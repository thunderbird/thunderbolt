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
import type { Context } from '@earendil-works/pi-ai'
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
    const sentinel = (async () => {
      sentinelCalls += 1
      return new Response('', { status: 500 })
    }) as unknown as typeof globalThis.fetch
    globalThis.fetch = sentinel

    const { models, model } = buildOpenAiCompatModel({
      providerId: 'openai',
      modelId: 'gpt-test',
      baseURL: 'https://upstream.example/v1',
      apiKey: 'test-key',
      fetch: injectedFetch,
      reasoning: false,
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
    try {
      for await (const event of stream) {
        void event
      }
    } catch {
      // A parse hiccup doesn't matter — the fetch-routing assertions below are the contract.
    }

    expect(injectedCalls).toBe(1)
    expect(injectedUrl).toContain('upstream.example')
    expect(sentinelCalls).toBe(0)
  })
})
