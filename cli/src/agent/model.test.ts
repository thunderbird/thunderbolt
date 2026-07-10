/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Branch coverage for `resolveModel`: the anthropic-vs-openai-compat routing,
 * the required-input guards for openai-compat (base URL + api key), and the
 * unknown-Anthropic-id failure. These run with no network — anthropic resolves
 * against Pi's wired built-in catalog and openai-compat synthesizes a local
 * descriptor.
 */

import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, test } from 'bun:test'
import { resolveModel } from './model.ts'

/** Pull a real catalog id from Pi's wired provider rather than hard-coding one,
 *  so this stays green across catalog churn. */
const KNOWN_ANTHROPIC = builtinModels().getModels('anthropic')[0]!.id

describe('resolveModel — openai-compat branch', () => {
  test('throws when --base-url is missing', () => {
    expect(() => resolveModel({ model: 'mimo', provider: 'openai-compat', apiKey: 'k' })).toThrow(/--base-url/)
  })

  test('throws when the api key is missing even with a base URL', () => {
    expect(() => resolveModel({ model: 'mimo', provider: 'openai-compat', baseUrl: 'https://h/v1' })).toThrow(
      /requires an api key/,
    )
  })

  test('rejects an empty-string base URL (falsy guard, not just undefined)', () => {
    expect(() => resolveModel({ model: 'mimo', provider: 'openai-compat', baseUrl: '', apiKey: 'k' })).toThrow(
      /--base-url/,
    )
  })

  test('rejects an empty-string api key', () => {
    expect(() => resolveModel({ model: 'mimo', provider: 'openai-compat', baseUrl: 'https://h/v1', apiKey: '' })).toThrow(
      /requires an api key/,
    )
  })

  test('resolves a synthetic model carrying the upstream id and base URL', () => {
    const { models, model } = resolveModel({
      model: 'mimo-v2.5-pro',
      provider: 'openai-compat',
      baseUrl: 'https://h/v1',
      apiKey: 'secret',
    })
    expect(model.id).toBe('mimo-v2.5-pro')
    expect(model.provider).toBe('openai-compat')
    expect(model.baseUrl).toBe('https://h/v1')
    // The model is registered in the returned collection under its provider.
    expect(models.getModel('openai-compat', 'mimo-v2.5-pro')?.id).toBe('mimo-v2.5-pro')
  })

  test('the resolved model descriptor does not embed the secret key', () => {
    const { model } = resolveModel({
      model: 'mimo',
      provider: 'openai-compat',
      baseUrl: 'https://h/v1',
      apiKey: 'super-secret-key',
    })
    expect(JSON.stringify(model)).not.toContain('super-secret-key')
  })
})

describe('resolveModel — anthropic branch (default)', () => {
  test('defaults to anthropic when no provider is given and resolves a known id', () => {
    const { model } = resolveModel({ model: KNOWN_ANTHROPIC })
    expect(model.id).toBe(KNOWN_ANTHROPIC)
    expect(model.provider).toBe('anthropic')
  })

  test('throws on an unknown Anthropic id', () => {
    expect(() => resolveModel({ model: 'claude-does-not-exist', provider: 'anthropic' })).toThrow(
      /Unknown Anthropic model/,
    )
  })

  test('ignores base URL / api key on the anthropic branch (never requires --base-url)', () => {
    // anthropic resolution must not trip the openai-compat base-url guard.
    const { model } = resolveModel({ model: KNOWN_ANTHROPIC, provider: 'anthropic', baseUrl: 'https://ignored' })
    expect(model.provider).toBe('anthropic')
  })
})
