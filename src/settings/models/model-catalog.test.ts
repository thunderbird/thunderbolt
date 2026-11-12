/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { http } from '@/lib/http'
import * as privatemode from '@/ai/privatemode-client'
import { stubJsonResponse } from '@/test-utils/http'
import { defaultModels } from '@shared/defaults/models'
import { i18n } from '@/i18n'
import {
  canFetchCatalog,
  catalogRequestKey,
  isFetchableCatalogUrl,
  catalogRowSupportsImages,
  fetchModelsForProvider,
  describeModelFetchError,
  thunderboltModelCatalog,
  type CatalogRequest,
} from './model-catalog'

const catalogResponse = () => Response.json({ data: [] })

it('does not expose provider error text or reflected secrets in catalog errors', () => {
  expect(describeModelFetchError(i18n, new Error('Authorization: Bearer private-key'))).toBe('Failed to load models')
  expect(
    describeModelFetchError(i18n, {
      response: new Response(null, { status: 401, statusText: 'private-key rejected' }),
    }),
  ).toBe('Server responded with status 401.')
})

const stubProxyFetch = () =>
  Object.assign(
    mock(async (_request: RequestInfo | URL) => catalogResponse()),
    { preconnect: async () => false },
  )

describe('model catalog policy', () => {
  it('derives Thunderbolt choices from shipped defaults', () => {
    expect(thunderboltModelCatalog.map((model) => model.id)).toEqual(
      defaultModels.filter((model) => model.provider === 'thunderbolt').map((model) => model.model),
    )
  })

  it('invalidates catalog identity when credentials or endpoint change', () => {
    const base = catalogRequestKey({ provider: 'custom', url: 'https://a.example/v1', apiKey: 'one' })
    expect(catalogRequestKey({ provider: 'custom', url: 'https://b.example/v1', apiKey: 'one' })).not.toBe(base)
    expect(catalogRequestKey({ provider: 'custom', url: 'https://a.example/v1', apiKey: 'two' })).not.toBe(base)
  })

  describe('isFetchableCatalogUrl', () => {
    it('rejects empty and missing URLs', () => {
      expect(isFetchableCatalogUrl(undefined)).toBe(false)
      expect(isFetchableCatalogUrl('')).toBe(false)
    })

    it('rejects half-typed hosts mid-keystroke', () => {
      expect(isFetchableCatalogUrl('http')).toBe(false)
      expect(isFetchableCatalogUrl('http://')).toBe(false)
      expect(isFetchableCatalogUrl('localhost:11434')).toBe(false)
    })

    it('accepts complete URLs', () => {
      expect(isFetchableCatalogUrl('http://localhost:11434/v1')).toBe(true)
      expect(isFetchableCatalogUrl('https://api.example.com/v1')).toBe(true)
    })
  })

  describe('canFetchCatalog', () => {
    it('blocks key-gated providers until an API key is present', () => {
      expect(canFetchCatalog({ provider: 'openai' })).toBe(false)
      expect(canFetchCatalog({ provider: 'openrouter', apiKey: '' })).toBe(false)
      expect(canFetchCatalog({ provider: 'anthropic', apiKey: 'sk-test' })).toBe(true)
      expect(canFetchCatalog({ provider: 'openai', apiKey: 'sk-test' })).toBe(true)
      expect(canFetchCatalog({ provider: 'privatemode' })).toBe(false)
      expect(canFetchCatalog({ provider: 'privatemode', apiKey: 'private-key' })).toBe(true)
    })

    it('blocks custom providers until the URL is fetchable', () => {
      expect(canFetchCatalog({ provider: 'custom', url: 'http' })).toBe(false)
      expect(canFetchCatalog({ provider: 'custom' })).toBe(false)
      expect(canFetchCatalog({ provider: 'custom', url: 'http://localhost:11434/v1' })).toBe(true)
    })

    it('allows credential-free providers unconditionally', () => {
      expect(canFetchCatalog({ provider: 'thunderbolt' })).toBe(true)
      expect(canFetchCatalog({ provider: 'tinfoil' })).toBe(true)
    })
  })

  describe('catalogRowSupportsImages', () => {
    it('reports image support from the listed input modalities', () => {
      expect(catalogRowSupportsImages({ id: 'a', architecture: { input_modalities: ['text', 'image'] } })).toBe(true)
      expect(catalogRowSupportsImages({ id: 'b', architecture: { input_modalities: ['text'] } })).toBe(false)
    })

    it('leaves support unknown when the catalog lists no modalities', () => {
      expect(catalogRowSupportsImages({ id: 'c' })).toBeUndefined()
      expect(catalogRowSupportsImages({ id: 'd', architecture: {} })).toBeUndefined()
    })
  })

  describe('fetchModelsForProvider', () => {
    it('loads Privatemode chat models through its SDK and preserves the advertised tools and vision capabilities', async () => {
      const send = mock(async () =>
        Response.json({
          data: [
            { id: 'text-model', tasks: ['generate'] },
            { id: 'embedding-model', tasks: ['embed'] },
            { id: 'image-model', tasks: ['generate', 'tool_calling', 'vision'] },
          ],
        }),
      )
      const acquire = spyOn(privatemode, 'getPrivatemodeClient').mockResolvedValue({
        baseURL: 'https://attested.example/v1',
        fetch: send,
        ensureVerified: async () => {},
        close: () => {},
      })
      const proxy = stubProxyFetch()
      const signal = new AbortController().signal
      try {
        const models = await fetchModelsForProvider(
          { provider: 'privatemode', apiKey: 'private-key', connectionId: 'work' },
          () => proxy,
          signal,
        )
        expect(acquire).toHaveBeenCalledWith({ apiKey: 'private-key', connectionId: 'work' })
        expect(
          models.map(({ id, supports_tools, supports_images }) => ({ id, supports_tools, supports_images })),
        ).toEqual([
          { id: 'image-model', supports_tools: true, supports_images: true },
          { id: 'text-model', supports_tools: false, supports_images: false },
        ])
        expect(proxy).not.toHaveBeenCalled()
        expect(send).toHaveBeenCalledTimes(1)
      } finally {
        acquire.mockRestore()
      }
    })

    it('does not acquire the Privatemode SDK without a key or after catalog cancellation', async () => {
      const acquire = spyOn(privatemode, 'getPrivatemodeClient').mockImplementation(async () => {
        throw new Error('must not acquire')
      })
      try {
        expect(await fetchModelsForProvider({ provider: 'privatemode' }, stubProxyFetch)).toEqual([])
        await expect(
          fetchModelsForProvider({ provider: 'privatemode', apiKey: 'key' }, stubProxyFetch, AbortSignal.abort()),
        ).rejects.toThrow()
        expect(acquire).not.toHaveBeenCalled()
      } finally {
        acquire.mockRestore()
      }
    })

    it('propagates Privatemode verification failures without falling back to the cloud proxy', async () => {
      const acquire = spyOn(privatemode, 'getPrivatemodeClient').mockRejectedValue(new Error('Verification failed'))
      const proxy = stubProxyFetch()
      try {
        await expect(fetchModelsForProvider({ provider: 'privatemode', apiKey: 'key' }, () => proxy)).rejects.toThrow(
          'Verification failed',
        )
        expect(proxy).not.toHaveBeenCalled()
      } finally {
        acquire.mockRestore()
      }
    })
    it.each<[CatalogRequest, string]>([
      [{ provider: 'openai', apiKey: 'sk-test' }, 'https://api.openai.com/v1/models'],
      [{ provider: 'openrouter', apiKey: 'sk-test' }, 'https://openrouter.ai/api/v1/models/user'],
    ])('routes the %o catalog through the supplied transport', async (request, endpoint) => {
      const proxyFetch = stubProxyFetch()
      await fetchModelsForProvider(request, () => proxyFetch)

      const sent = new Request(proxyFetch.mock.calls[0][0])
      expect(sent.url).toBe(endpoint)
      expect(sent.headers.get('Authorization')).toBe('Bearer sk-test')
    })

    it('routes the Anthropic catalog through the supplied transport with scoped credentials', async () => {
      const requests: Request[] = []
      const proxyFetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(new Request(input, init))
          return Response.json({ data: [{ id: 'claude-test', display_name: 'Claude Test' }] })
        },
        { preconnect: async () => false },
      )

      const webviewFetch = spyOn(globalThis, 'fetch').mockResolvedValue(catalogResponse())
      try {
        const models = await fetchModelsForProvider({ provider: 'anthropic', apiKey: 'own-key' }, () => proxyFetch)

        expect(models).toEqual([{ id: 'claude-test', name: 'Claude Test' }])
        expect(requests[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000')
        expect(requests[0].headers.get('x-api-key')).toBe('own-key')
        expect(requests[0].headers.get('authorization')).toBeNull()
        expect(requests[0].headers.get('anthropic-version')).toBe('2023-06-01')
        expect(requests[0].headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
      } finally {
        webviewFetch.mockRestore()
      }
    })

    it('keeps loopback custom endpoints off the proxy, like chat does', async () => {
      const proxyFetch = stubProxyFetch()
      const directFetch = spyOn(globalThis, 'fetch').mockResolvedValue(catalogResponse())
      try {
        await fetchModelsForProvider({ provider: 'custom', url: 'http://localhost:1234' }, () => proxyFetch)

        expect(new Request(directFetch.mock.calls[0][0]).url).toBe('http://localhost:1234/v1/models')
        expect(proxyFetch).not.toHaveBeenCalled()
      } finally {
        directFetch.mockRestore()
      }
    })

    it('keeps Otari catalog credentials direct and blocks redirects, like chat does', async () => {
      const proxyFetch = stubProxyFetch()
      const directFetch = spyOn(globalThis, 'fetch').mockResolvedValue(catalogResponse())
      try {
        await fetchModelsForProvider(
          { provider: 'otari', url: 'https://api.otari.ai/api/v1', apiKey: 'delegated-key' },
          () => proxyFetch,
        )
        const request = new Request(...directFetch.mock.calls[0])
        expect(request.url).toBe('https://api.otari.ai/api/v1/models')
        expect(request.headers.get('Authorization')).toBe('Bearer delegated-key')
        expect(request.credentials).toBe('omit')
        expect(request.redirect).toBe('error')
        expect(proxyFetch).not.toHaveBeenCalled()
      } finally {
        directFetch.mockRestore()
      }
    })
  })
})

describe('fetchModelsForProvider', () => {
  it('loads the OpenRouter account catalog with its key and preserves model capabilities', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(
      stubJsonResponse({
        data: [
          {
            id: 'vendor/vision',
            name: 'Vision',
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text', 'image'] },
          },
          { id: 'vendor/chat', name: 'Chat', supported_parameters: [], architecture: { input_modalities: ['text'] } },
        ],
      }),
    )
    try {
      const models = await fetchModelsForProvider({ provider: 'openrouter', apiKey: 'user-key' }, stubProxyFetch)

      expect(getSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models/user',
        expect.objectContaining({ headers: { Authorization: 'Bearer user-key' } }),
      )
      expect(
        models.map(({ id, name, supports_tools, supports_images }) => ({ id, name, supports_tools, supports_images })),
      ).toEqual([
        { id: 'vendor/chat', name: 'Chat', supports_tools: undefined, supports_images: false },
        { id: 'vendor/vision', name: 'Vision', supports_tools: undefined, supports_images: true },
      ])
    } finally {
      getSpy.mockRestore()
    }
  })

  it('does not fall back to the unfiltered OpenRouter catalog without a key', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    try {
      expect(await fetchModelsForProvider({ provider: 'openrouter' }, stubProxyFetch)).toEqual([])
      expect(getSpy).not.toHaveBeenCalled()
    } finally {
      getSpy.mockRestore()
    }
  })

  it.each([
    { provider: 'openai' as const, apiKey: 'openai-key', endpoint: 'https://api.openai.com/v1/models' },
    { provider: 'custom' as const, url: 'http://localhost:11434', endpoint: 'http://localhost:11434/v1/models' },
  ])('keeps the standard models endpoint for $provider', async ({ endpoint, ...request }) => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [{ id: 'chat-model' }] }))
    try {
      expect(await fetchModelsForProvider(request, stubProxyFetch)).toEqual([
        { id: 'chat-model', supports_images: undefined },
      ])
      expect(getSpy).toHaveBeenCalledWith(endpoint, expect.any(Object))
    } finally {
      getSpy.mockRestore()
    }
  })
})

describe('fetchModelsForProvider', () => {
  it('loads the OpenRouter account catalog with its key and preserves model capabilities', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(
      stubJsonResponse({
        data: [
          {
            id: 'vendor/vision',
            name: 'Vision',
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text', 'image'] },
          },
          { id: 'vendor/chat', name: 'Chat', supported_parameters: [], architecture: { input_modalities: ['text'] } },
        ],
      }),
    )
    try {
      const models = await fetchModelsForProvider({ provider: 'openrouter', apiKey: 'user-key' }, stubProxyFetch)

      expect(getSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models/user',
        expect.objectContaining({ headers: { Authorization: 'Bearer user-key' } }),
      )
      expect(
        models.map(({ id, name, supports_tools, supports_images }) => ({ id, name, supports_tools, supports_images })),
      ).toEqual([
        { id: 'vendor/chat', name: 'Chat', supports_tools: undefined, supports_images: false },
        { id: 'vendor/vision', name: 'Vision', supports_tools: undefined, supports_images: true },
      ])
    } finally {
      getSpy.mockRestore()
    }
  })

  it('does not fall back to the unfiltered OpenRouter catalog without a key', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    try {
      expect(await fetchModelsForProvider({ provider: 'openrouter' }, stubProxyFetch)).toEqual([])
      expect(getSpy).not.toHaveBeenCalled()
    } finally {
      getSpy.mockRestore()
    }
  })

  it.each([
    { provider: 'openai' as const, apiKey: 'openai-key', endpoint: 'https://api.openai.com/v1/models' },
    { provider: 'custom' as const, url: 'http://localhost:11434', endpoint: 'http://localhost:11434/v1/models' },
  ])('keeps the standard models endpoint for $provider', async ({ endpoint, ...request }) => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [{ id: 'chat-model' }] }))
    try {
      expect(await fetchModelsForProvider(request, stubProxyFetch)).toEqual([
        { id: 'chat-model', supports_images: undefined },
      ])
      expect(getSpy).toHaveBeenCalledWith(endpoint, expect.any(Object))
    } finally {
      getSpy.mockRestore()
    }
  })
})
