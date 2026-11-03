/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { http } from '@/lib/http'
import { stubJsonResponse } from '@/test-utils/http'
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
      const models = await fetchModelsForProvider({ provider: 'openrouter', apiKey: 'user-key' })

      expect(getSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models/user',
        expect.objectContaining({ headers: { Authorization: 'Bearer user-key' } }),
      )
      expect(
        models.map(({ id, name, supports_tools, supports_images }) => ({ id, name, supports_tools, supports_images })),
      ).toEqual([
        { id: 'vendor/chat', name: 'Chat', supports_tools: false, supports_images: false },
        { id: 'vendor/vision', name: 'Vision', supports_tools: true, supports_images: true },
      ])
    } finally {
      getSpy.mockRestore()
    }
  })

  it('does not fall back to the unfiltered OpenRouter catalog without a key', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    try {
      expect(await fetchModelsForProvider({ provider: 'openrouter' })).toEqual([])
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
      expect(await fetchModelsForProvider(request)).toEqual([
        { id: 'chat-model', supports_tools: false, supports_images: undefined },
      ])
      expect(getSpy).toHaveBeenCalledWith(endpoint, expect.any(Object))
    } finally {
      getSpy.mockRestore()
    }
  })
})
