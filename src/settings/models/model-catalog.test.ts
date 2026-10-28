/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { defaultModels } from '@shared/defaults/models'
import {
  canFetchCatalog,
  catalogRequestKey,
  isFetchableCatalogUrl,
  catalogRowSupportsImages,
  fetchModelsForProvider,
  thunderboltModelCatalog,
  type CatalogRequest,
} from './model-catalog'

const catalogResponse = () => Response.json({ data: [] })

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
    it.each<[CatalogRequest, string]>([
      [
        { provider: 'custom', url: 'https://api.otari.ai/api/v1', apiKey: 'sk-test' },
        'https://api.otari.ai/api/v1/models',
      ],
      [{ provider: 'openai', apiKey: 'sk-test' }, 'https://api.openai.com/v1/models'],
      [{ provider: 'openrouter', apiKey: 'sk-test' }, 'https://openrouter.ai/api/v1/models'],
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

        expect(models).toEqual([{ id: 'claude-test', name: 'Claude Test', supports_tools: true }])
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
  })
})
