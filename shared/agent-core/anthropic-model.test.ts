/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for {@link buildAnthropicModel} / {@link isKnownAnthropicModel}.
 *
 * The module's whole reason to exist is the simple→full options bridge: Pi's
 * `streamSimple` rebuilds options via `buildBaseOptions` and DROPS the pre-built
 * `client`, so this module re-implements the bridge to (a) keep the injected
 * `fetch`-bearing client alive through `streamSimple`, and (b) shape the request's
 * thinking config correctly. These tests pin that behaviour at the wire boundary:
 * they drive a real `streamSimple` against an injected `fetch`, capture the JSON
 * body the `@anthropic-ai/sdk` actually emits, and assert the thinking/effort/
 * max_tokens fields — plus that the injected fetch (not the global) served it.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { buildAnthropicModel, isKnownAnthropicModel, type AgentFetch } from './anthropic-model.ts'

/** Minimal well-formed Anthropic messages SSE: a start then an immediate stop, so
 *  the SDK parses a clean stream rather than erroring mid-iteration. */
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

const CONTEXT: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }

type CapturedBody = {
  max_tokens?: number
  thinking?: { type: string; budget_tokens?: number }
  output_config?: { effort?: string }
}

type DriveResult = { body: CapturedBody | null; headers: Headers | null; injectedCalls: number }

/** Build the model and drive `streamSimple`, capturing the request body the SDK
 *  emits through the injected fetch. `entry` selects which provider entrypoint to
 *  exercise (the harness uses `streamSimple`; `stream` is the full path). */
const drive = async (
  modelId: string,
  options: SimpleStreamOptions,
  entry: 'streamSimple' | 'stream' = 'streamSimple',
): Promise<DriveResult> => {
  let body: CapturedBody | null = null
  let headers: Headers | null = null
  let injectedCalls = 0
  const injectedFetch: AgentFetch = async (_input, init) => {
    injectedCalls += 1
    headers = init?.headers ? new Headers(init.headers) : null
    body = init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const { models, model } = buildAnthropicModel({ apiKey: 'test-key', fetch: injectedFetch, modelId })
  const provider = models.getProvider('anthropic')
  if (!provider) throw new Error('anthropic provider not registered')

  const stream = provider[entry](model, CONTEXT, options)
  try {
    for await (const event of stream) void event
  } catch {
    // Stream-parse hiccups are irrelevant; the captured request body is the contract.
  }
  return { body, headers, injectedCalls }
}

describe('isKnownAnthropicModel', () => {
  it('returns true for a model the built-in anthropic-messages catalog resolves', () => {
    expect(isKnownAnthropicModel('claude-opus-4-8')).toBe(true)
  })

  it('returns false for ids the catalog lacks (so the caller falls back, not crashes)', () => {
    expect(isKnownAnthropicModel('claude-3-5-sonnet-latest')).toBe(false)
    expect(isKnownAnthropicModel('totally-not-a-real-model')).toBe(false)
  })
})

describe('buildAnthropicModel — resolution', () => {
  const fetchFn: AgentFetch = async () => new Response('', { status: 200 })

  it('throws on a model id outside the built-in catalog', () => {
    expect(() => buildAnthropicModel({ apiKey: 'k', fetch: fetchFn, modelId: 'bogus-model' })).toThrow(
      /Unknown Anthropic model "bogus-model"/,
    )
  })

  it('resolves a known model and registers the anthropic provider', () => {
    const { models, model } = buildAnthropicModel({ apiKey: 'k', fetch: fetchFn, modelId: 'claude-opus-4-8' })
    expect(model.id).toBe('claude-opus-4-8')
    expect(model.baseUrl).toBe('https://api.anthropic.com')
    expect(models.getProvider('anthropic')).toBeTruthy()
  })
})

describe('buildAnthropicModel — streamSimple request shaping', () => {
  it('disables thinking and keeps the model max_tokens when reasoning is off', async () => {
    const { body } = await drive('claude-opus-4-8', {} as SimpleStreamOptions)
    expect(body?.thinking).toEqual({ type: 'disabled' })
    // No caller cap → the model cap (128000) flows through with no thinking budget added.
    expect(body?.max_tokens).toBe(128000)
  })

  it('uses ADAPTIVE thinking (not a fixed budget) for a forceAdaptiveThinking model', async () => {
    const { body } = await drive('claude-opus-4-8', { reasoning: 'high' } as SimpleStreamOptions)
    expect(body?.thinking?.type).toBe('adaptive')
    expect(body?.thinking?.budget_tokens).toBeUndefined()
    expect(body?.output_config?.effort).toBe('high')
  })

  it('maps every Pi thinking level to the right adaptive effort, honoring the catalog override', async () => {
    const expectEffort = async (level: string, effort: string) => {
      const { body } = await drive('claude-opus-4-8', { reasoning: level } as SimpleStreamOptions)
      expect(body?.output_config?.effort).toBe(effort)
    }
    await expectEffort('minimal', 'low')
    await expectEffort('low', 'low')
    await expectEffort('medium', 'medium')
    await expectEffort('high', 'high')
    // opus-4-8's thinkingLevelMap remaps xhigh→xhigh; without the override the
    // default branch would collapse it to 'high', so this pins the override path.
    await expectEffort('xhigh', 'xhigh')
  })

  it('uses ENABLED thinking with a level-sized budget for a non-adaptive model', async () => {
    const high = await drive('claude-opus-4-1', { reasoning: 'high' } as SimpleStreamOptions)
    expect(high.body?.thinking).toMatchObject({ type: 'enabled', budget_tokens: 16384 })
    expect(high.body?.thinking?.type).not.toBe('adaptive')
    // Budget tracks the reasoning level, not the model.
    const low = await drive('claude-opus-4-1', { reasoning: 'low' } as SimpleStreamOptions)
    expect(low.body?.thinking).toMatchObject({ type: 'enabled', budget_tokens: 2048 })
    // No caller cap → clamped to the model's own max_tokens.
    expect(high.body?.max_tokens).toBe(32000)
  })

  it('forwards a caller maxTokens cap into the thinking-budget math (cap + budget)', async () => {
    // Proves the bridge carries the caller's `maxTokens` through buildBaseOptions
    // into adjustMaxTokensForThinking — 1000 cap + 16384 high budget = 17384.
    const { body } = await drive('claude-opus-4-1', { reasoning: 'high', maxTokens: 1000 } as SimpleStreamOptions)
    expect(body?.max_tokens).toBe(17384)
    expect(body?.thinking?.budget_tokens).toBe(16384)
  })
})

describe('buildAnthropicModel — injected-fetch client survives the bridge', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('routes streamSimple HTTP through the injected fetch, never the global', async () => {
    let sentinelHits = 0
    globalThis.fetch = (async () => {
      sentinelHits += 1
      return new Response('', { status: 500 })
    }) as unknown as typeof globalThis.fetch

    // Regression guard: vanilla Pi streamSimple drops the pre-built client (and thus
    // the injected fetch). If the bridge ever stops carrying it, the request falls
    // through to the global sentinel and these assertions fail loudly.
    const { injectedCalls } = await drive('claude-opus-4-8', {} as SimpleStreamOptions)
    expect(injectedCalls).toBe(1)
    expect(sentinelHits).toBe(0)
  })

  it('the full `stream` entrypoint also carries the injected client', async () => {
    const { injectedCalls, body } = await drive('claude-opus-4-8', {} as SimpleStreamOptions, 'stream')
    expect(injectedCalls).toBe(1)
    expect(body?.max_tokens).toBeGreaterThan(0)
  })

  it('restores the static browser-direct-access headers Pi would otherwise add', async () => {
    // Handing Pi a pre-built client bypasses its per-request header logic; the two
    // static headers needed for direct browser access must be restored on the wire.
    const { headers } = await drive('claude-opus-4-8', {} as SimpleStreamOptions)
    expect(headers?.get('accept')).toBe('application/json')
    expect(headers?.get('anthropic-dangerous-direct-browser-access')).toBe('true')
  })
})
