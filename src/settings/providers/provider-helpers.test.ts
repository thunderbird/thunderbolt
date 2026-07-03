/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { Provider } from '@/dal'
import type { CatalogModel } from '@/lib/providers/validate'
import type { ProviderType } from '@shared/providers'
import {
  buildConnectTargets,
  filterCatalogModels,
  providerDisplayLabel,
  providerEnabledCapabilities,
} from './provider-helpers'

const makeProvider = (overrides: Partial<Provider>): Provider =>
  ({
    id: 'p1',
    type: 'openrouter',
    label: null,
    baseUrl: null,
    enabledCapabilities: ['models'],
    enabled: 1,
    deletedAt: null,
    defaultHash: null,
    userId: 'u1',
    workspaceId: 'w1',
    scope: 'workspace',
    ...overrides,
  }) as Provider

describe('buildConnectTargets', () => {
  it('orders model providers before search providers and de-duplicates', () => {
    const targets = buildConnectTargets(new Set())
    expect(targets[0]).toBe('openrouter')
    // model providers come before any search-only provider
    expect(targets.indexOf('openrouter')).toBeLessThan(targets.indexOf('exa'))
    // no duplicates
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('excludes already-connected types', () => {
    const connected = new Set<ProviderType>(['openrouter', 'exa'])
    const targets = buildConnectTargets(connected)
    expect(targets).not.toContain('openrouter')
    expect(targets).not.toContain('exa')
  })
})

describe('providerDisplayLabel', () => {
  it('prefers the account label', () => {
    expect(providerDisplayLabel(makeProvider({ label: 'me@example.com' }))).toBe('me@example.com')
  })

  it('falls back to the catalog name when label is blank', () => {
    expect(providerDisplayLabel(makeProvider({ label: '  ', type: 'openrouter' }))).toBe('OpenRouter')
  })
})

describe('providerEnabledCapabilities', () => {
  it('returns the stored subset', () => {
    expect(providerEnabledCapabilities(makeProvider({ type: 'tinfoil', enabledCapabilities: ['search'] }))).toEqual([
      'search',
    ])
  })

  it('falls back to the catalog capabilities when null', () => {
    expect(providerEnabledCapabilities(makeProvider({ type: 'tinfoil', enabledCapabilities: null }))).toEqual([
      'models',
      'search',
    ])
  })
})

describe('filterCatalogModels', () => {
  const models: CatalogModel[] = [
    { id: 'openai/gpt-4', name: 'GPT-4' },
    { id: 'anthropic/claude', name: 'Claude' },
  ]

  it('returns all models for a blank query', () => {
    expect(filterCatalogModels(models, '  ')).toHaveLength(2)
  })

  it('matches on id or name, case-insensitively', () => {
    expect(filterCatalogModels(models, 'CLAUDE')).toEqual([{ id: 'anthropic/claude', name: 'Claude' }])
    expect(filterCatalogModels(models, 'gpt')).toEqual([{ id: 'openai/gpt-4', name: 'GPT-4' }])
  })
})
