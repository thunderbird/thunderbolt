/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  apiKeyEditValue,
  catalogRequiresApiKey,
  hasModelConnectionChanges,
  modelApiKeyForConnection,
  providerAutoFetchesCatalog,
  shouldDisableAddModel,
  isModelAvailable,
  isModelReady,
  modelRequiresServer,
  needsApiKey,
} from './model-policy'

import { createMockModel } from '@/test-utils/chat-store-mocks'

const model = {
  model: 'gpt-4',
  url: 'https://api.example.com/v1',
}

describe('standalone model availability', () => {
  it('requires a server for Thunderbolt and system Tinfoil credentials', () => {
    expect(modelRequiresServer({ provider: 'thunderbolt', isSystem: 0 })).toBe(true)
    expect(isModelAvailable({ provider: 'thunderbolt', isSystem: 1 }, '')).toBe(false)
    expect(isModelAvailable({ provider: 'tinfoil', isSystem: 1 }, '')).toBe(false)
    expect(isModelAvailable({ provider: 'tinfoil', isSystem: 1 }, 'https://server.example/v1')).toBe(true)
  })

  it('accepts local endpoints and user credentials without a server', () => {
    expect(isModelAvailable({ provider: 'custom', isSystem: 0 }, '')).toBe(true)
    expect(isModelAvailable({ provider: 'openai', isSystem: 0 }, '')).toBe(true)
    expect(isModelAvailable({ provider: 'tinfoil', isSystem: 0 }, '')).toBe(true)
    expect(needsApiKey({ provider: 'openai', isSystem: 0, apiKey: null })).toBe(true)
  })
})

describe('model readiness', () => {
  it.each([null, '', '   '])('requires a configured custom endpoint (%s)', (url) => {
    expect(isModelReady(createMockModel({ provider: 'custom', url }), '')).toBe(false)
  })
  it('allows a custom endpoint without a key', () => {
    expect(
      isModelReady(createMockModel({ provider: 'custom', url: 'http://localhost:11434/v1', apiKey: null }), ''),
    ).toBe(true)
  })
  it('rejects disabled, deleted, and keyless provider models', () => {
    for (const overrides of [{ enabled: 0 }, { deletedAt: '2026-01-01' }, { apiKey: null }]) {
      expect(isModelReady(createMockModel(overrides), '')).toBe(false)
    }
  })
})

describe('model edit policy', () => {
  it('does not require a connection test for a name-only edit', () => {
    expect(
      hasModelConnectionChanges(model, {
        model: 'gpt-4',
        url: 'https://api.example.com/v1',
        apiKeyEdit: { kind: 'keep' },
      }),
    ).toBe(false)
  })

  it('marks endpoint, model, and credential edits as connection changes', () => {
    expect(
      hasModelConnectionChanges(model, {
        model: 'gpt-5',
        url: model.url,
        apiKeyEdit: { kind: 'keep' },
      }),
    ).toBe(true)
    expect(
      hasModelConnectionChanges(model, {
        model: model.model,
        url: model.url,
        apiKeyEdit: { kind: 'clear' },
      }),
    ).toBe(true)
  })

  it('maps keep, replace, and clear to DAL semantics', () => {
    expect(apiKeyEditValue({ kind: 'keep' })).toBeUndefined()
    expect(apiKeyEditValue({ kind: 'replace', value: 'new-key' })).toBe('new-key')
    expect(apiKeyEditValue({ kind: 'clear' })).toBeNull()
  })

  it('uses a stored key only for explicit connection actions while keeping it out of the form', () => {
    expect(modelApiKeyForConnection('saved-key', { kind: 'keep' })).toBe('saved-key')
    expect(modelApiKeyForConnection('saved-key', { kind: 'replace', value: 'new-key' })).toBe('new-key')
    expect(modelApiKeyForConnection('saved-key', { kind: 'clear' })).toBeUndefined()
  })
})

describe('catalog policy', () => {
  it('requires a key only where the provider list endpoint does', () => {
    expect(catalogRequiresApiKey('openai')).toBe(true)
    expect(catalogRequiresApiKey('openrouter')).toBe(true)
    expect(catalogRequiresApiKey('anthropic')).toBe(true)
    expect(catalogRequiresApiKey('tinfoil')).toBe(false)
    expect(catalogRequiresApiKey('thunderbolt')).toBe(false)
    expect(catalogRequiresApiKey('custom')).toBe(false)
  })

  it('auto-fetches exactly the keyless, url-less catalogs', () => {
    expect(providerAutoFetchesCatalog('thunderbolt')).toBe(true)
    expect(providerAutoFetchesCatalog('tinfoil')).toBe(true)
    expect(providerAutoFetchesCatalog('anthropic')).toBe(false)
    expect(providerAutoFetchesCatalog('openai')).toBe(false)
    expect(providerAutoFetchesCatalog('custom')).toBe(false)
  })
})

describe('shouldDisableAddModel', () => {
  it('enables submission only when validation and connection gates pass', () => {
    const base = { isPending: false, isFormValid: true } as const
    expect(shouldDisableAddModel({ ...base, provider: 'thunderbolt', connectionStatus: 'idle' })).toBe(false)
    expect(shouldDisableAddModel({ ...base, provider: 'openai', connectionStatus: 'success' })).toBe(false)
    expect(shouldDisableAddModel({ ...base, provider: 'openai', connectionStatus: 'idle' })).toBe(true)
    expect(
      shouldDisableAddModel({ ...base, isFormValid: false, provider: 'thunderbolt', connectionStatus: 'idle' }),
    ).toBe(true)
    expect(shouldDisableAddModel({ ...base, isPending: true, provider: 'thunderbolt', connectionStatus: 'idle' })).toBe(
      true,
    )
  })
})
