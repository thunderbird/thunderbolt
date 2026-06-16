/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { RegistryEntry } from '@/types/registry'
import {
  distributionLabel,
  filterRegistry,
  normalizeQuery,
  parseRegistryJson,
  primaryDistributionKind,
} from './agent-registry-filter'

const makeEntry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: 'goose',
  name: 'goose',
  version: '1.0.0',
  description: 'Extensible open-source AI agent from Block',
  authors: ['Block'],
  license: 'Apache-2.0',
  repository: 'https://github.com/block/goose',
  website: 'https://block.github.io/goose/',
  icon: 'https://cdn.example.com/goose.svg',
  distribution: { npx: { package: 'goose@1.0.0' } },
  ...overrides,
})

const entries: ReadonlyArray<RegistryEntry> = [
  makeEntry({ id: 'goose', name: 'goose', description: 'Extensible agent from Block', authors: ['Block'] }),
  makeEntry({ id: 'gemini', name: 'Gemini CLI', description: 'Google terminal agent', authors: ['Google'] }),
  makeEntry({ id: 'claude-acp', name: 'Claude Code', description: 'Anthropic coding tool', authors: ['Anthropic'] }),
]

describe('parseRegistryJson', () => {
  it('parses a valid registry object into typed entries', () => {
    const raw = {
      version: '1.0.0',
      agents: [
        {
          id: 'claude-acp',
          name: 'Claude Agent',
          version: '0.44.0',
          description: 'ACP wrapper',
          authors: ['Anthropic'],
          license: 'proprietary',
          repository: 'https://github.com/x/y',
          icon: 'https://cdn/x.svg',
          distribution: { npx: { package: '@x/y@0.44.0', args: ['--acp'] } },
        },
      ],
    }
    const parsed = parseRegistryJson(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual({
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '0.44.0',
      description: 'ACP wrapper',
      authors: ['Anthropic'],
      license: 'proprietary',
      repository: 'https://github.com/x/y',
      website: undefined,
      icon: 'https://cdn/x.svg',
      distribution: { npx: { package: '@x/y@0.44.0', args: ['--acp'] } },
    })
  })

  it('accepts a bare entry array', () => {
    const parsed = parseRegistryJson([{ id: 'a', name: 'A', distribution: {} }])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('a')
  })

  it('drops entries missing id or name', () => {
    const parsed = parseRegistryJson({
      agents: [{ id: 'ok', name: 'Ok', distribution: {} }, { name: 'No id' }, { id: 'no-name' }, 'garbage', null],
    })
    expect(parsed.map((entry) => entry.id)).toEqual(['ok'])
  })

  it('defaults missing optional fields and normalizes distribution', () => {
    const parsed = parseRegistryJson([{ id: 'min', name: 'Min', distribution: { uvx: { package: 'min' } } }])
    expect(parsed[0]).toEqual({
      id: 'min',
      name: 'Min',
      version: '',
      description: '',
      authors: [],
      license: '',
      repository: undefined,
      website: undefined,
      icon: undefined,
      distribution: { uvx: { package: 'min', args: [] } },
    })
  })

  it('drops non-http(s) repository / website / icon URLs (javascript:/data: injection)', () => {
    const parsed = parseRegistryJson([
      {
        id: 'evil',
        name: 'Evil',
        repository: 'data:text/html,<script>alert(1)</script>',
        website: 'javascript:alert(1)',
        icon: 'javascript:alert(document.cookie)',
        distribution: {},
      },
    ])
    expect(parsed[0]?.repository).toBeUndefined()
    expect(parsed[0]?.website).toBeUndefined()
    expect(parsed[0]?.icon).toBeUndefined()
  })

  it('keeps valid http(s) repository / website / icon URLs', () => {
    const parsed = parseRegistryJson([
      {
        id: 'safe',
        name: 'Safe',
        repository: 'https://github.com/x/y',
        website: 'http://example.com',
        icon: 'https://cdn.example.com/x.svg',
        distribution: {},
      },
    ])
    expect(parsed[0]?.repository).toBe('https://github.com/x/y')
    expect(parsed[0]?.website).toBe('http://example.com')
    expect(parsed[0]?.icon).toBe('https://cdn.example.com/x.svg')
  })

  it('returns [] for non-array / garbage input', () => {
    expect(parseRegistryJson(null)).toEqual([])
    expect(parseRegistryJson(undefined)).toEqual([])
    expect(parseRegistryJson(42)).toEqual([])
    expect(parseRegistryJson('nope')).toEqual([])
    expect(parseRegistryJson({})).toEqual([])
    expect(parseRegistryJson({ agents: 'not-an-array' })).toEqual([])
  })
})

describe('primaryDistributionKind', () => {
  it('prefers npx over uvx and binary', () => {
    expect(primaryDistributionKind(makeEntry({ distribution: { npx: { package: 'a' }, uvx: { package: 'b' } } }))).toBe(
      'npx',
    )
  })

  it('falls back to uvx then binary', () => {
    expect(primaryDistributionKind(makeEntry({ distribution: { uvx: { package: 'b' } } }))).toBe('uvx')
    expect(primaryDistributionKind(makeEntry({ distribution: { binary: { 'darwin-aarch64': {} } } }))).toBe('binary')
  })

  it('returns null when there is no distribution', () => {
    expect(primaryDistributionKind(makeEntry({ distribution: {} }))).toBeNull()
  })
})

describe('distributionLabel', () => {
  it('maps kinds to human labels', () => {
    expect(distributionLabel('npx')).toBe('Node.js')
    expect(distributionLabel('uvx')).toBe('Python')
    expect(distributionLabel('binary')).toBe('Binary')
  })
})

describe('normalizeQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeQuery('  GoOSE  ')).toBe('goose')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeQuery('   ')).toBe('')
  })
})

describe('filterRegistry', () => {
  it('returns all entries for an empty query', () => {
    expect(filterRegistry(entries, '')).toEqual(entries)
  })

  it('returns all entries for a whitespace-only query', () => {
    expect(filterRegistry(entries, '   ')).toEqual(entries)
  })

  it('matches on name case-insensitively', () => {
    const result = filterRegistry(entries, 'GEMINI')
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('gemini')
  })

  it('matches on description', () => {
    const result = filterRegistry(entries, 'anthropic')
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('claude-acp')
  })

  it('matches on id', () => {
    const result = filterRegistry(entries, 'claude-acp')
    expect(result.map((entry) => entry.id)).toEqual(['claude-acp'])
  })

  it('matches on authors', () => {
    const result = filterRegistry(entries, 'google')
    expect(result.map((entry) => entry.id)).toEqual(['gemini'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterRegistry(entries, 'zzzqqqxx')).toEqual([])
  })

  it('returns multiple matches (but not all)', () => {
    // "agent" appears in the goose and gemini descriptions only.
    const result = filterRegistry(entries, 'agent')
    expect(result.map((entry) => entry.id)).toEqual(['goose', 'gemini'])
  })
})
