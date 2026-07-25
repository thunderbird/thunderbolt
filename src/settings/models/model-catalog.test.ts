/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { defaultModels } from '@shared/defaults/models'
import { canFetchCatalog, catalogRequestKey, isFetchableCatalogUrl, thunderboltModelCatalog } from './model-catalog'

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
