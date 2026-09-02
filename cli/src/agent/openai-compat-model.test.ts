/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Coverage for `buildOpenAiCompatModel`: the synthetic descriptor it produces
 * (the `reasoning: false` portability clamp, the base URL the key will be sent
 * to, provider registration) and the `requireOpenAiCompletions` guard that
 * surfaces a mis-dispatched model loudly instead of guessing — exercised via the
 * provider's `stream` entry point, which narrows before any network call.
 */

import type { Api, AssistantMessageEventStream, Context, Model } from '@earendil-works/pi-ai'
import { describe, expect, test } from 'bun:test'
import { type OpenAiCompatFetch, type OpenAiStreamFns, buildOpenAiCompatModel } from './openai-compat-model.ts'

const opts = { modelId: 'llama3.3', baseUrl: 'http://localhost:11434/v1', apiKey: 'local' }

/** A fake pair of raw stream fns that record the options they were handed and
 *  return an inert stream, so the bearer-key injection is observable offline. */
const capturingStreamFns = () => {
  const calls: { fn: 'stream' | 'streamSimple'; model: Model<Api>; options: Record<string, unknown> }[] = []
  const inert = {} as AssistantMessageEventStream
  const streamFns = {
    stream: ((model, _context, options) => {
      calls.push({ fn: 'stream', model, options: { ...options } })
      return inert
    }) as OpenAiStreamFns['stream'],
    streamSimple: ((model, _context, options) => {
      calls.push({ fn: 'streamSimple', model, options: { ...options } })
      return inert
    }) as OpenAiStreamFns['streamSimple'],
  }
  return { streamFns, calls }
}

describe('buildOpenAiCompatModel — synthetic descriptor', () => {
  test('carries the upstream id, base URL, and provider id', () => {
    const { model } = buildOpenAiCompatModel(opts)
    expect(model.id).toBe('llama3.3')
    expect(model.name).toBe('llama3.3')
    expect(model.provider).toBe('openai-compat')
    expect(model.baseUrl).toBe('http://localhost:11434/v1')
    expect(model.api).toBe('openai-completions')
  })

  test('clamps reasoning off for cross-endpoint portability', () => {
    // Non-reasoning endpoints reject a `reasoning_effort`; `reasoning: false`
    // makes Pi send none. This is a behavioral contract, not cosmetic.
    const { model } = buildOpenAiCompatModel(opts)
    expect(model.reasoning).toBe(false)
  })

  test('registers the model in the returned collection under its provider', () => {
    const { models } = buildOpenAiCompatModel(opts)
    expect(models.getModel('openai-compat', 'llama3.3')?.id).toBe('llama3.3')
    expect(models.getProvider('openai-compat')?.baseUrl).toBe('http://localhost:11434/v1')
  })

  test('supports an owned provider id and catalog-provided capabilities', () => {
    const { models, model } = buildOpenAiCompatModel({
      ...opts,
      providerId: 'thunderbolt',
      reasoning: true,
      contextWindow: 200_000,
      supportsImages: true,
    })

    expect(model).toMatchObject({
      provider: 'thunderbolt',
      reasoning: true,
      contextWindow: 200_000,
      input: ['text', 'image'],
    })
    expect(models.getModel('thunderbolt', 'llama3.3')).toBe(model)
    expect(models.getProvider('openai-compat')).toBeUndefined()
  })
})

describe('buildOpenAiCompatModel — requireOpenAiCompletions guard', () => {
  test('the provider stream rejects a model dispatched with a non-completions api', () => {
    const { models, model } = buildOpenAiCompatModel(opts)
    const provider = models.getProvider('openai-compat')
    if (!provider) throw new Error('provider not registered')

    // A model whose api is not openai-completions must be rejected synchronously,
    // before the openai SDK is ever constructed (so no network is touched).
    const mismatched = { ...model, api: 'anthropic-messages' } as Model<Api>
    expect(() => provider.stream(mismatched, {} as Context, {})).toThrow(/Expected an "openai-completions" model/)
  })

  test('streamSimple applies the same guard', () => {
    const { models, model } = buildOpenAiCompatModel(opts)
    const provider = models.getProvider('openai-compat')
    if (!provider) throw new Error('provider not registered')
    const mismatched = { ...model, api: 'anthropic-messages' } as Model<Api>
    expect(() => provider.streamSimple(mismatched, {} as Context, {})).toThrow(/got "anthropic-messages"/)
  })
})

describe('buildOpenAiCompatModel — bearer key injection (security)', () => {
  test('stream injects opts.apiKey onto the per-call options', () => {
    const { streamFns, calls } = capturingStreamFns()
    const { models, model } = buildOpenAiCompatModel(opts, streamFns)
    const provider = models.getProvider('openai-compat')!
    provider.stream(model, {} as Context, { maxTokens: 256 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.options.apiKey).toBe('local')
    // Caller-supplied options must be preserved alongside the injected key.
    expect(calls[0]!.options.maxTokens).toBe(256)
  })

  test('the injected key overrides any caller-supplied options.apiKey (no spoofing)', () => {
    const { streamFns, calls } = capturingStreamFns()
    const { models, model } = buildOpenAiCompatModel(opts, streamFns)
    const provider = models.getProvider('openai-compat')!
    // A caller trying to slip a different key in must not win over the resolved one.
    provider.stream(model, {} as Context, { apiKey: 'attacker-supplied' } as never)
    expect(calls[0]!.options.apiKey).toBe('local')
  })

  test('streamSimple also injects the configured key', () => {
    const { streamFns, calls } = capturingStreamFns()
    const { models, model } = buildOpenAiCompatModel(opts, streamFns)
    const provider = models.getProvider('openai-compat')!
    provider.streamSimple(model, {} as Context, {})
    expect(calls[0]).toMatchObject({ fn: 'streamSimple', options: { apiKey: 'local' } })
  })

  test('captures an injected fetch only while Pi constructs its OpenAI client', async () => {
    let injectedCalls = 0
    const injectedFetch: OpenAiCompatFetch = async () => {
      injectedCalls += 1
      return new Response(null, { status: 204 })
    }
    const observedFetches: (typeof globalThis.fetch)[] = []
    const requests: Promise<Response>[] = []
    const inert = {} as AssistantMessageEventStream
    const streamFns = {
      stream: (() => {
        observedFetches.push(globalThis.fetch)
        requests.push(globalThis.fetch('http://localhost:11434/v1/models'))
        return inert
      }) as OpenAiStreamFns['stream'],
      streamSimple: (() => {
        observedFetches.push(globalThis.fetch)
        requests.push(globalThis.fetch('http://localhost:11434/v1/models'))
        return inert
      }) as OpenAiStreamFns['streamSimple'],
    }
    const { models, model } = buildOpenAiCompatModel({ ...opts, fetchFn: injectedFetch }, streamFns)
    const provider = models.getProvider('openai-compat')!

    provider.stream(model, {} as Context, {})
    provider.streamSimple(model, {} as Context, {})
    await Promise.all(requests)

    expect(observedFetches).toHaveLength(2)
    expect(observedFetches.every((fetchFn) => fetchFn === globalThis.fetch)).toBe(true)
    expect(injectedCalls).toBe(2)
  })
})
