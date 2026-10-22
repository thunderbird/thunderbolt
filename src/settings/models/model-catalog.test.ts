/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { FetchFn } from '@/lib/proxy-fetch'
import { defaultModels } from '@shared/defaults/models'
import {
  canFetchCatalog,
  catalogRequestKey,
  isFetchableCatalogUrl,
  catalogRowSupportsImages,
  fetchModelsForProvider,
  thunderboltModelCatalog,
} from './model-catalog'

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
      expect(canFetchCatalog({ provider: 'otari' })).toBe(false)
      expect(canFetchCatalog({ provider: 'otari', apiKey: 'tk-test' })).toBe(true)
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
})

describe('Otari catalog', () => {
  it('does not send a request without an API key', async () => {
    const transport = Object.assign(
      mock(async () => Response.json({ data: [] })),
      {
        preconnect: async () => false,
      },
    )
    expect(await fetchModelsForProvider({ provider: 'otari' }, transport)).toEqual([])
    expect(transport).not.toHaveBeenCalled()
  })

  it('uses the proxy transport with bearer auth and preserves provider-prefixed IDs', async () => {
    const requests: Request[] = []
    const transport: FetchFn = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return Response.json({
          data: [
            { id: 'openai:gpt-4o', owned_by: 'openai' },
            { id: 'anthropic:claude-sonnet-4-6', supports_tools: true },
          ],
        })
      },
      { preconnect: async () => false },
    )
    const models = await fetchModelsForProvider({ provider: 'otari', apiKey: 'tk-test' }, transport)
    expect(models.map((model) => model.id)).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-4o'])
    expect(models[0].supports_tools).toBe(true)
    expect(models[1].supports_images).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://api.otari.ai/api/v1/models')
    expect(requests[0].headers.get('authorization')).toBe('Bearer tk-test')
  })

  it('surfaces an invalid API key instead of returning an empty catalog', async () => {
    const transport = Object.assign(async () => Response.json({ detail: 'Invalid key' }, { status: 401 }), {
      preconnect: async () => false,
    })
    await expect(fetchModelsForProvider({ provider: 'otari', apiKey: 'invalid' }, transport)).rejects.toMatchObject({
      response: { status: 401 },
    })
  })
})
