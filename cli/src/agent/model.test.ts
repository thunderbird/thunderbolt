/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
import { buildBuiltinProfileModel, configureNativeWebSearch } from './model.ts'
import type { BuiltinProvider } from './types.ts'

/** First catalog model for a provider — read from Pi's wired catalog rather
 *  than hard-coded, so tests stay green across catalog churn. Throws loudly
 *  if the catalog ever ships empty for a curated provider. */
const firstCatalogModel = (provider: BuiltinProvider) => {
  const model = builtinModels().getModels(provider)[0]
  if (!model) throw new Error(`Pi catalog has no models for ${provider}`)
  return model
}

describe('configureNativeWebSearch', () => {
  test('adds Anthropic server-side web search beside local tools', () => {
    expect(
      configureNativeWebSearch(
        { provider: 'anthropic', api: 'anthropic-messages' },
        { tools: [{ name: 'read', type: 'custom' }] },
      ),
    ).toEqual({
      tools: [
        { name: 'read', type: 'custom' },
        { name: 'web_search', type: 'web_search_20250305' },
      ],
    })
  })

  test('adds native search only for OpenAI models using Responses API', () => {
    expect(
      configureNativeWebSearch(
        { provider: 'openai', api: 'openai-responses' },
        { tools: [{ type: 'function', name: 'read' }] },
      ),
    ).toEqual({
      tools: [{ type: 'function', name: 'read' }, { type: 'web_search' }],
    })

    const completionsPayload = { tools: [{ type: 'function', name: 'read' }] }
    expect(configureNativeWebSearch({ provider: 'openai', api: 'openai-completions' }, completionsPayload)).toBe(
      completionsPayload,
    )
  })

  test('leaves providers without supported native search unchanged', () => {
    const payload = { tools: [{ name: 'read' }] }
    expect(configureNativeWebSearch({ provider: 'google', api: 'google-generative-ai' }, payload)).toBe(payload)
  })
})

const capturingProfileSource = (builtinProvider: BuiltinProvider, probeUrl?: (baseUrl: string) => string) => {
  const sourceModel = firstCatalogModel(builtinProvider)
  const sourceProvider = builtinModels().getProvider(builtinProvider)
  if (!sourceProvider?.baseUrl) throw new Error(`Pi catalog has no base URL for ${builtinProvider}`)
  const baseUrl = sourceProvider.baseUrl
  const calls: {
    readonly fn: 'stream' | 'streamSimple'
    readonly provider: string
    readonly apiKey: string | undefined
  }[] = []
  const capturedFetches: (typeof globalThis.fetch)[] = []
  const requests: Promise<Response>[] = []
  const inertStream = () => {
    const stream = createAssistantMessageEventStream()
    stream.end()
    return stream
  }
  const streams: ProviderStreams = {
    stream: (model, _context, options) => {
      capturedFetches.push(globalThis.fetch)
      if (probeUrl) requests.push(globalThis.fetch(probeUrl(baseUrl)))
      calls.push({ fn: 'stream', provider: model.provider, apiKey: options?.apiKey })
      return inertStream()
    },
    streamSimple: (model, _context, options) => {
      capturedFetches.push(globalThis.fetch)
      if (probeUrl) requests.push(globalThis.fetch(probeUrl(baseUrl)))
      calls.push({ fn: 'streamSimple', provider: model.provider, apiKey: options?.apiKey })
      return inertStream()
    },
  }
  const models = createModels()
  models.setProvider(
    createProvider({
      id: builtinProvider,
      baseUrl: sourceProvider.baseUrl,
      auth: { apiKey: envApiKeyAuth(`${builtinProvider} key`, []) },
      models: [sourceModel],
      api: streams,
    }),
  )
  return { models, sourceModel, calls, capturedFetches, requests, baseUrl }
}

describe('buildBuiltinProfileModel', () => {
  test('requires and honors an explicit API for unknown mixed-protocol Fireworks models', () => {
    const source = builtinModels()
    const fireworksModels = source.getModels('fireworks')
    const anthropic = fireworksModels.find(({ api }) => api === 'anthropic-messages')
    const openai = fireworksModels.find(({ api }) => api === 'openai-completions')
    if (!anthropic || !openai) throw new Error('Fireworks fixture must expose both protocols')

    const known = buildBuiltinProfileModel(
      {
        profileId: 'fireworks-known',
        provider: 'fireworks',
        modelId: anthropic.id,
        apiKey: 'key',
      },
      source,
    ).model
    expect(known.api).toBe(anthropic.api)
    expect(known.baseUrl).toBe(anthropic.baseUrl)
    const knownWithStaleApi = buildBuiltinProfileModel(
      {
        profileId: 'fireworks-known-stale',
        provider: 'fireworks',
        modelId: anthropic.id,
        apiKey: 'key',
        modelApi: 'openai-completions',
      },
      source,
    ).model
    expect(knownWithStaleApi).toMatchObject({ api: anthropic.api, baseUrl: anthropic.baseUrl })
    expect(() =>
      buildBuiltinProfileModel(
        {
          profileId: 'fireworks-unknown',
          provider: 'fireworks',
          modelId: 'future-fireworks-model',
          apiKey: 'key',
        },
        source,
      ),
    ).toThrow(/API format/i)

    for (const modelApi of ['anthropic-messages', 'openai-completions'] as const) {
      const built = buildBuiltinProfileModel(
        {
          profileId: `fireworks-${modelApi}`,
          provider: 'fireworks',
          modelId: 'future-fireworks-model',
          apiKey: 'key',
          modelApi,
        },
        source,
      )
      const template = modelApi === 'anthropic-messages' ? anthropic : openai
      expect(built.model).toMatchObject({
        id: 'future-fireworks-model',
        api: modelApi,
        baseUrl: template.baseUrl,
      })
    }
  })

  test('captures the common origin-bound fetch for a built-in BYOK provider', async () => {
    const source = capturingProfileSource('openai', () => 'https://redirect-target.example/stolen')
    const cloned = buildBuiltinProfileModel(
      {
        profileId: 'openai-profile',
        provider: 'openai',
        modelId: source.sourceModel.id,
        apiKey: 'provider-key',
      },
      source.models,
    )

    cloned.provider.stream(cloned.model, { messages: [] }, {})

    expect(source.capturedFetches[0]).toBe(globalThis.fetch)
    await expect(source.requests[0]).rejects.toThrow('origin')
  })

  test('does not add the Thunderbolt app version header to a BYOK provider request', async () => {
    const requests: Request[] = []
    const source = capturingProfileSource('openai', (baseUrl) => `${baseUrl}/models`)
    const cloned = buildBuiltinProfileModel(
      {
        profileId: 'openai-profile',
        provider: 'openai',
        modelId: source.sourceModel.id,
        apiKey: 'provider-key',
        fetchFn: async (input, init) => {
          requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init))
          return Response.json({ data: [] })
        },
      },
      source.models,
    )

    cloned.provider.stream(cloned.model, { messages: [] }, {})
    await source.requests[0]

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.has('x-app-version')).toBe(false)
  })

  test('clones provider ownership while keeping the public model id and metadata', () => {
    const source = capturingProfileSource('openai')
    const cloned = buildBuiltinProfileModel(
      {
        profileId: 'openai-work',
        provider: 'openai',
        modelId: source.sourceModel.id,
        apiKey: 'work-key',
      },
      source.models,
    )

    expect(cloned.model).toEqual({ ...source.sourceModel, provider: 'openai-work' })
    expect(cloned.provider.id).toBe('openai-work')
    expect(cloned.provider.getModels()).toEqual([cloned.model])
    expect(JSON.stringify(cloned.model)).not.toContain('work-key')
  })

  test('adapts a newly listed upstream model that is absent from the bundled Pi catalog', () => {
    const source = capturingProfileSource('openai')

    const cloned = buildBuiltinProfileModel(
      {
        profileId: 'openai-work',
        provider: 'openai',
        modelId: 'future-openai-model',
        apiKey: 'work-key',
      },
      source.models,
    )

    expect(cloned.model).toMatchObject({
      id: 'future-openai-model',
      name: 'future-openai-model',
      provider: 'openai-work',
    })
  })

  test('injects the selected key in both provider stream paths', () => {
    const source = capturingProfileSource('openai')
    const cloned = buildBuiltinProfileModel(
      {
        profileId: 'openai-work',
        provider: 'openai',
        modelId: source.sourceModel.id,
        apiKey: 'work-key',
      },
      source.models,
    )
    const context: Context = { messages: [] }

    cloned.provider.stream(cloned.model, context, { apiKey: 'caller-key' })
    cloned.provider.streamSimple(cloned.model, context, { apiKey: 'caller-key' })

    expect(source.calls).toEqual([
      { fn: 'stream', provider: 'openai', apiKey: 'work-key' },
      { fn: 'streamSimple', provider: 'openai', apiKey: 'work-key' },
    ])
  })

  test('preserves Anthropic and OpenAI native web-search behavior after profile cloning', () => {
    for (const builtinProvider of ['anthropic', 'openai'] as const) {
      const source = capturingProfileSource(builtinProvider)
      const cloned = buildBuiltinProfileModel(
        {
          profileId: `${builtinProvider}-work`,
          provider: builtinProvider,
          modelId: source.sourceModel.id,
          apiKey: 'work-key',
        },
        source.models,
      )
      const configured = configureNativeWebSearch(cloned.model, { tools: [] })

      expect(configured).toMatchObject({
        tools: builtinProvider === 'anthropic' ? [{ name: 'web_search' }] : [{ type: 'web_search' }],
      })
    }
  })
})
