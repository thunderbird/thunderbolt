/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, spyOn } from 'bun:test'
import { defaultModels } from '@shared/defaults/models'
import { http } from '@/lib/http'
import { stubJsonResponse } from '@/test-utils/http'
import {
  canFetchCatalog,
  catalogRequestKey,
  fetchModelsForProvider,
  isFetchableCatalogUrl,
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
})

describe('fetchModelsForProvider Ollama path', () => {
  it('prefers /api/tags capabilities when the Custom URL looks like Ollama', async () => {
    const getSpy = spyOn(http, 'get').mockImplementation((url: string) => {
      if (String(url).includes('/api/tags')) {
        return stubJsonResponse({
          models: [
            {
              name: 'qwen2.5:14b',
              details: { context_length: 32_768 },
              capabilities: ['completion', 'tools'],
            },
          ],
        })
      }
      throw new Error(`unexpected catalog URL: ${url}`)
    })

    try {
      const models = await fetchModelsForProvider({
        provider: 'custom',
        url: 'http://localhost:11434/v1',
      })
      expect(models).toEqual([
        {
          id: 'qwen2.5:14b',
          name: 'qwen2.5:14b',
          supports_tools: true,
          supports_thinking: false,
          supports_vision: false,
          context_window: 32_768,
        },
      ])
      expect(getSpy.mock.calls.some((call) => String(call[0]).endsWith('/api/tags'))).toBe(true)
    } finally {
      getSpy.mockRestore()
    }
  })

  it('falls back to /v1/models when /api/tags fails for an Ollama-like URL', async () => {
    const getSpy = spyOn(http, 'get').mockImplementation((url: string) => {
      if (String(url).includes('/api/tags')) {
        throw new Error('connection refused')
      }
      return stubJsonResponse({ data: [{ id: 'fallback-model' }] })
    })

    try {
      const models = await fetchModelsForProvider({
        provider: 'custom',
        url: 'http://localhost:11434/v1',
      })
      expect(models.map((model) => model.id)).toEqual(['fallback-model'])
      expect(getSpy.mock.calls.some((call) => String(call[0]).endsWith('/api/tags'))).toBe(true)
      expect(getSpy.mock.calls.some((call) => String(call[0]).includes('/v1/models'))).toBe(true)
    } finally {
      getSpy.mockRestore()
    }
  })

  it('falls back to /v1/models when /api/tags returns a non-Ollama body', async () => {
    const getSpy = spyOn(http, 'get').mockImplementation((url: string) => {
      if (String(url).includes('/api/tags')) {
        return stubJsonResponse({ status: 'ok' })
      }
      return stubJsonResponse({ data: [{ id: 'openai-compat-model' }] })
    })

    try {
      const models = await fetchModelsForProvider({
        provider: 'custom',
        url: 'http://ollama:11434/v1',
      })
      expect(models.map((model) => model.id)).toEqual(['openai-compat-model'])
    } finally {
      getSpy.mockRestore()
    }
  })
})
