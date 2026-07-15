/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Branch coverage for `resolveModel`: built-in provider catalog lookup and
 * credentials, explicit key forwarding, plus openai-compat input guards.
 */

import {
  type Context,
  type ProviderStreams,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, test } from 'bun:test'
import { resolveModel } from './model.ts'
import { BUILTIN_PROVIDERS } from './types.ts'

/** Pull a real catalog id from Pi's wired provider rather than hard-coding one,
 *  so this stays green across catalog churn. */
const KNOWN_ANTHROPIC = builtinModels().getModels('anthropic')[0]!.id

const EMPTY_ENV: Readonly<Record<string, string | undefined>> = {}

/** Builds a one-model OpenAI catalog whose stream options are observable. */
const capturingBuiltinModels = () => {
  const model = builtinModels().getModels('openai')[0]!
  const calls: { readonly fn: 'stream' | 'streamSimple'; readonly options: Record<string, unknown> }[] = []
  /** Creates an already-ended stream so Pi's lazy delegate can drain it. */
  const inertStream = () => {
    const stream = createAssistantMessageEventStream()
    stream.end()
    return stream
  }
  const streams = {
    stream: ((_model, _context, options) => {
      calls.push({ fn: 'stream', options: { ...options } })
      return inertStream()
    }) as ProviderStreams['stream'],
    streamSimple: ((_model, _context, options) => {
      calls.push({ fn: 'streamSimple', options: { ...options } })
      return inertStream()
    }) as ProviderStreams['streamSimple'],
  }
  const models = createModels({
    authContext: {
      env: async (name) => (name === 'OPENAI_API_KEY' ? 'env-key' : undefined),
      fileExists: async () => false,
    },
  })
  models.setProvider(
    createProvider({
      id: 'openai',
      auth: { apiKey: envApiKeyAuth('OpenAI API key', ['OPENAI_API_KEY']) },
      models: [model],
      api: streams,
    }),
  )
  return { models, model, calls }
}

describe('resolveModel — openai-compat branch', () => {
  test('throws when --base-url is missing', () => {
    expect(() => resolveModel({ model: 'llama3.3', provider: 'openai-compat', apiKey: 'local' })).toThrow(/--base-url/)
  })

  test('throws when the api key is missing even with a base URL', () => {
    expect(() =>
      resolveModel({ model: 'llama3.3', provider: 'openai-compat', baseUrl: 'http://localhost:11434/v1' }),
    ).toThrow(/requires an api key/)
  })

  test('missing custom key error points non-TTY users to guided setup', () => {
    expect(() =>
      resolveModel({ model: 'llama3.3', provider: 'openai-compat', baseUrl: 'http://localhost:11434/v1' }),
    ).toThrow(/THUNDERBOLT_OPENAI_COMPAT_KEY.*--api-key.*run `thunderbolt` in a terminal for guided setup/)
  })

  test('missing custom key stays actionable when the base URL is also missing', () => {
    expect(() => resolveModel({ model: 'llama3.3', provider: 'openai-compat' })).toThrow(
      /THUNDERBOLT_OPENAI_COMPAT_KEY.*--api-key.*run `thunderbolt` in a terminal for guided setup/,
    )
  })

  test('rejects an empty-string base URL (falsy guard, not just undefined)', () => {
    expect(() => resolveModel({ model: 'llama3.3', provider: 'openai-compat', baseUrl: '', apiKey: 'local' })).toThrow(
      /--base-url/,
    )
  })

  test('rejects an empty-string api key', () => {
    expect(() =>
      resolveModel({ model: 'llama3.3', provider: 'openai-compat', baseUrl: 'http://localhost:11434/v1', apiKey: '' }),
    ).toThrow(/requires an api key/)
  })

  test('resolves a synthetic model carrying the upstream id and base URL', () => {
    const { models, model } = resolveModel({
      model: 'llama3.3',
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'local',
    })
    expect(model.id).toBe('llama3.3')
    expect(model.provider).toBe('openai-compat')
    expect(model.baseUrl).toBe('http://localhost:11434/v1')
    // The model is registered in the returned collection under its provider.
    expect(models.getModel('openai-compat', 'llama3.3')?.id).toBe('llama3.3')
  })

  test('the resolved model descriptor does not embed the secret key', () => {
    const { model } = resolveModel({
      model: 'llama3.3',
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'super-secret-key',
    })
    expect(JSON.stringify(model)).not.toContain('super-secret-key')
  })
})

describe('resolveModel — built-in providers', () => {
  test('defaults to anthropic when no provider is given and resolves a known id', () => {
    const { model } = resolveModel({ model: KNOWN_ANTHROPIC, apiKey: 'explicit-key' })
    expect(model.id).toBe(KNOWN_ANTHROPIC)
    expect(model.provider).toBe('anthropic')
  })

  test('resolves catalog models for every curated provider', () => {
    for (const provider of BUILTIN_PROVIDERS) {
      const modelId = builtinModels().getModels(provider)[0]!.id
      expect(resolveModel({ model: modelId, provider, apiKey: 'explicit-key' }).model.provider).toBe(provider)
    }
  })

  test('unknown-model error includes valid ids read from that provider catalog', () => {
    const validIds = builtinModels()
      .getModels('google')
      .slice(0, 3)
      .map((model) => model.id)
    expect(() => resolveModel({ model: 'gemini-does-not-exist', provider: 'google', apiKey: 'key' })).toThrow(
      new RegExp(validIds.join('|')),
    )
  })

  test('missing-key error names provider env variable and --api-key', () => {
    expect(() =>
      resolveModel(
        { model: builtinModels().getModels('google')[0]!.id, provider: 'google' },
        { builtinModels, env: EMPTY_ENV },
      ),
    ).toThrow(/GEMINI_API_KEY.*--api-key|--api-key.*GEMINI_API_KEY/)
  })

  test('missing built-in key error points non-TTY users to guided setup', () => {
    expect(() =>
      resolveModel(
        { model: builtinModels().getModels('google')[0]!.id, provider: 'google' },
        { builtinModels, env: EMPTY_ENV },
      ),
    ).toThrow(/GEMINI_API_KEY.*--api-key.*run `thunderbolt` in a terminal for guided setup/)
  })

  test('missing built-in credentials stay actionable when the model id is also invalid', () => {
    expect(() =>
      resolveModel({ model: 'not-a-google-model', provider: 'google' }, { builtinModels, env: EMPTY_ENV }),
    ).toThrow(/GEMINI_API_KEY.*--api-key.*run `thunderbolt` in a terminal for guided setup/)
  })

  test('explicit key overrides provider env auth in both Models stream paths', async () => {
    const capture = capturingBuiltinModels()
    const { models, model } = resolveModel(
      { model: capture.model.id, provider: 'openai', apiKey: 'flag-key' },
      { builtinModels: () => capture.models, env: { OPENAI_API_KEY: 'env-key' } },
    )

    for await (const _event of models.streamSimple(model, {} as Context)) {
      // Inert test stream emits no events.
    }
    for await (const _event of models.stream(model, {} as Context)) {
      // Inert test stream emits no events.
    }

    expect(capture.calls).toEqual([
      { fn: 'streamSimple', options: expect.objectContaining({ apiKey: 'flag-key' }) },
      { fn: 'stream', options: expect.objectContaining({ apiKey: 'flag-key' }) },
    ])
  })

  test('explicit key does not become model descriptor data', () => {
    const { model } = resolveModel({ model: KNOWN_ANTHROPIC, provider: 'anthropic', apiKey: 'super-secret' })
    expect(JSON.stringify(model)).not.toContain('super-secret')
  })

  test('without an explicit key, Pi resolves the provider environment variable', async () => {
    const capture = capturingBuiltinModels()
    const { models, model } = resolveModel(
      { model: capture.model.id, provider: 'openai' },
      { builtinModels: () => capture.models, env: { OPENAI_API_KEY: 'env-key' } },
    )

    expect((await models.getAuth(model))?.auth.apiKey).toBe('env-key')
  })
})
