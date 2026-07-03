/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  MODEL_PROVIDER_ORDER,
  PROVIDER_CATALOG,
  SEARCH_PROVIDER_ORDER,
  authHeaderName,
  formatAuthHeaderValue,
  getProviderDefinition,
  providerNeedsCredential,
  providersWithCapability,
} from './providers'

describe('provider catalog', () => {
  it('every catalog entry keys itself by its own type', () => {
    for (const [key, def] of Object.entries(PROVIDER_CATALOG)) {
      expect(def.type).toBe(key as typeof def.type)
    }
  })

  it('models-capable providers declare models endpoints; search-capable declare search endpoints', () => {
    for (const def of Object.values(PROVIDER_CATALOG)) {
      if (def.capabilities.includes('models')) expect(def.models).toBeDefined()
      if (def.capabilities.includes('search')) expect(def.search).toBeDefined()
    }
  })

  it('oauth-pkce providers declare oauth endpoints', () => {
    for (const def of Object.values(PROVIDER_CATALOG)) {
      if (def.connectionType === 'oauth-pkce') expect(def.oauth).toBeDefined()
    }
  })

  it('url providers require a base URL', () => {
    for (const def of Object.values(PROVIDER_CATALOG)) {
      if (def.connectionType === 'url' && !def.free) expect(def.requiresBaseUrl).toBe(true)
    }
  })

  it('tinfoil is the multi-capability provider (the thesis)', () => {
    expect(getProviderDefinition('tinfoil').capabilities).toEqual(['models', 'search'])
  })

  it('providersWithCapability filters correctly', () => {
    const modelTypes = providersWithCapability('models').map((p) => p.type)
    expect(modelTypes).toContain('openrouter')
    expect(modelTypes).toContain('tinfoil')
    expect(modelTypes).not.toContain('exa')

    const searchTypes = providersWithCapability('search').map((p) => p.type)
    expect(searchTypes).toContain('exa')
    expect(searchTypes).toContain('duckduckgo')
    expect(searchTypes).not.toContain('openai')
  })

  it('order arrays reference only existing model/search providers', () => {
    for (const t of MODEL_PROVIDER_ORDER) expect(PROVIDER_CATALOG[t].capabilities).toContain('models')
    for (const t of SEARCH_PROVIDER_ORDER) expect(PROVIDER_CATALOG[t].capabilities).toContain('search')
  })

  it('providerNeedsCredential is false for free/keyless providers', () => {
    expect(providerNeedsCredential('duckduckgo')).toBe(false)
    expect(providerNeedsCredential('searxng')).toBe(false)
    expect(providerNeedsCredential('openrouter')).toBe(true)
    expect(providerNeedsCredential('exa')).toBe(true)
  })

  it('auth header formatting matches scheme', () => {
    const openai = getProviderDefinition('openai')
    expect(authHeaderName(openai)).toBe('Authorization')
    expect(formatAuthHeaderValue(openai, 'sk-1')).toBe('Bearer sk-1')

    const anthropic = getProviderDefinition('anthropic')
    expect(authHeaderName(anthropic)).toBe('x-api-key')
    expect(formatAuthHeaderValue(anthropic, 'sk-1')).toBe('sk-1')

    const brave = getProviderDefinition('brave')
    expect(authHeaderName(brave)).toBe('X-Subscription-Token')
  })
})
