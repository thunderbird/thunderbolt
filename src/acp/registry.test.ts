import { describe, expect, it } from 'bun:test'
import type { RegistryEntry, RegistryDistribution } from './registry'
import {
  parseRegistryJson,
  getRegistryPlatformKey,
  isAgentAvailableForPlatform,
  getPreferredDistribution,
} from './registry'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeNpxEntry = (overrides?: Partial<RegistryEntry>): RegistryEntry => ({
  id: 'claude-acp',
  name: 'Claude Agent',
  version: '0.24.2',
  description: 'Claude Code ACP adapter',
  authors: ['Anthropic'],
  license: 'MIT',
  distribution: {
    npx: { package: '@agentclientprotocol/claude-agent-acp@0.24.2' },
  },
  ...overrides,
})

const makeBinaryEntry = (overrides?: Partial<RegistryEntry>): RegistryEntry => ({
  id: 'goose',
  name: 'goose',
  version: '1.29.0',
  description: 'Block goose agent',
  authors: ['Block'],
  license: 'Apache-2.0',
  distribution: {
    binary: {
      'darwin-aarch64': { archive: 'https://example.com/goose-darwin-arm64.tar.gz', cmd: './goose' },
      'darwin-x86_64': { archive: 'https://example.com/goose-darwin-x64.tar.gz', cmd: './goose' },
      'linux-x86_64': { archive: 'https://example.com/goose-linux-x64.tar.gz', cmd: './goose' },
    },
  },
  ...overrides,
})

const makeUvxEntry = (overrides?: Partial<RegistryEntry>): RegistryEntry => ({
  id: 'fast-agent',
  name: 'fast-agent',
  version: '0.6.10',
  description: 'Fast agent for Python',
  authors: ['FastAgent'],
  license: 'MIT',
  distribution: {
    uvx: { package: 'fast-agent@0.6.10' },
  },
  ...overrides,
})

const makeMultiDistEntry = (): RegistryEntry => ({
  id: 'kilo',
  name: 'Kilo',
  version: '7.1.11',
  description: 'Kilo agent with multiple distributions',
  authors: ['Kilo'],
  license: 'MIT',
  distribution: {
    binary: {
      'darwin-aarch64': { archive: 'https://example.com/kilo.tar.gz', cmd: './kilo' },
    },
    npx: { package: '@kilo/agent@7.1.11' },
  },
})

const makeRegistryJson = (agents: RegistryEntry[]) => JSON.stringify({ version: '1.0.0', agents, extensions: [] })

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('registry types', () => {
  it('RegistryEntry has required fields', () => {
    const entry = makeNpxEntry()
    expect(entry.id).toBe('claude-acp')
    expect(entry.name).toBe('Claude Agent')
    expect(entry.version).toBe('0.24.2')
    expect(entry.description).toBeDefined()
    expect(entry.authors).toBeInstanceOf(Array)
    expect(entry.license).toBeDefined()
    expect(entry.distribution).toBeDefined()
  })

  it('RegistryEntry optional fields can be omitted', () => {
    const entry = makeNpxEntry()
    expect(entry.icon).toBeUndefined()
    expect(entry.repository).toBeUndefined()
    expect(entry.website).toBeUndefined()
  })

  it('RegistryEntry optional fields can be set', () => {
    const entry = makeNpxEntry({
      icon: 'https://cdn.example.com/icon.svg',
      repository: 'https://github.com/example/repo',
      website: 'https://example.com',
    })
    expect(entry.icon).toBe('https://cdn.example.com/icon.svg')
    expect(entry.repository).toBe('https://github.com/example/repo')
    expect(entry.website).toBe('https://example.com')
  })
})

describe('parseRegistryJson', () => {
  it('parses valid registry JSON with npx agents', () => {
    const json = makeRegistryJson([makeNpxEntry()])
    const result = parseRegistryJson(json)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('claude-acp')
    expect(result[0].distribution.npx).toBeDefined()
  })

  it('parses valid registry JSON with binary agents', () => {
    const json = makeRegistryJson([makeBinaryEntry()])
    const result = parseRegistryJson(json)
    expect(result).toHaveLength(1)
    expect(result[0].distribution.binary).toBeDefined()
    expect(result[0].distribution.binary?.['darwin-aarch64']).toBeDefined()
  })

  it('parses valid registry JSON with uvx agents', () => {
    const json = makeRegistryJson([makeUvxEntry()])
    const result = parseRegistryJson(json)
    expect(result).toHaveLength(1)
    expect(result[0].distribution.uvx).toBeDefined()
  })

  it('parses agents with multiple distribution types', () => {
    const json = makeRegistryJson([makeMultiDistEntry()])
    const result = parseRegistryJson(json)
    expect(result).toHaveLength(1)
    expect(result[0].distribution.binary).toBeDefined()
    expect(result[0].distribution.npx).toBeDefined()
  })

  it('parses multiple agents', () => {
    const json = makeRegistryJson([makeNpxEntry(), makeBinaryEntry(), makeUvxEntry()])
    const result = parseRegistryJson(json)
    expect(result).toHaveLength(3)
  })

  it('returns empty array for empty agents list', () => {
    const json = makeRegistryJson([])
    const result = parseRegistryJson(json)
    expect(result).toHaveLength(0)
  })

  it('returns empty array for malformed JSON', () => {
    const result = parseRegistryJson('not valid json')
    expect(result).toHaveLength(0)
  })

  it('returns empty array for JSON without agents key', () => {
    const result = parseRegistryJson(JSON.stringify({ version: '1.0.0' }))
    expect(result).toHaveLength(0)
  })

  it('returns empty array for null/undefined', () => {
    const result = parseRegistryJson('')
    expect(result).toHaveLength(0)
  })

  it('preserves optional fields when present', () => {
    const entry = makeNpxEntry({
      icon: 'https://cdn.example.com/icon.svg',
      repository: 'https://github.com/test/repo',
      website: 'https://test.com',
    })
    const json = makeRegistryJson([entry])
    const result = parseRegistryJson(json)
    expect(result[0].icon).toBe('https://cdn.example.com/icon.svg')
    expect(result[0].repository).toBe('https://github.com/test/repo')
    expect(result[0].website).toBe('https://test.com')
  })

  it('preserves distribution args and env', () => {
    const entry = makeNpxEntry({
      distribution: {
        npx: {
          package: '@test/agent@1.0.0',
          args: ['--acp'],
          env: { NO_AUTO_UPDATE: '1' },
        },
      },
    })
    const json = makeRegistryJson([entry])
    const result = parseRegistryJson(json)
    expect(result[0].distribution.npx?.args).toEqual(['--acp'])
    expect(result[0].distribution.npx?.env).toEqual({ NO_AUTO_UPDATE: '1' })
  })
})

describe('getRegistryPlatformKey', () => {
  it('maps macos + aarch64 to darwin-aarch64', () => {
    expect(getRegistryPlatformKey('macos', 'aarch64')).toBe('darwin-aarch64')
  })

  it('maps macos + x86_64 to darwin-x86_64', () => {
    expect(getRegistryPlatformKey('macos', 'x86_64')).toBe('darwin-x86_64')
  })

  it('maps linux + x86_64 to linux-x86_64', () => {
    expect(getRegistryPlatformKey('linux', 'x86_64')).toBe('linux-x86_64')
  })

  it('maps linux + aarch64 to linux-aarch64', () => {
    expect(getRegistryPlatformKey('linux', 'aarch64')).toBe('linux-aarch64')
  })

  it('maps windows + x86_64 to windows-x86_64', () => {
    expect(getRegistryPlatformKey('windows', 'x86_64')).toBe('windows-x86_64')
  })

  it('maps windows + aarch64 to windows-aarch64', () => {
    expect(getRegistryPlatformKey('windows', 'aarch64')).toBe('windows-aarch64')
  })

  it('returns null for unsupported platform', () => {
    expect(getRegistryPlatformKey('web', 'x86_64')).toBeNull()
  })

  it('returns null for unsupported arch', () => {
    expect(getRegistryPlatformKey('macos', 'mips' as any)).toBeNull()
  })
})

describe('isAgentAvailableForPlatform', () => {
  it('returns true for npx agent (always available on any platform)', () => {
    const entry = makeNpxEntry()
    expect(isAgentAvailableForPlatform(entry, 'darwin-aarch64')).toBe(true)
  })

  it('returns true for uvx agent (always available on any platform)', () => {
    const entry = makeUvxEntry()
    expect(isAgentAvailableForPlatform(entry, 'darwin-aarch64')).toBe(true)
  })

  it('returns true for binary agent with matching platform', () => {
    const entry = makeBinaryEntry()
    expect(isAgentAvailableForPlatform(entry, 'darwin-aarch64')).toBe(true)
  })

  it('returns false for binary-only agent with non-matching platform', () => {
    const entry = makeBinaryEntry({
      distribution: {
        binary: {
          'linux-x86_64': { archive: 'https://example.com/agent.tar.gz', cmd: './agent' },
        },
      },
    })
    expect(isAgentAvailableForPlatform(entry, 'darwin-aarch64')).toBe(false)
  })

  it('returns true for multi-dist agent when binary matches platform', () => {
    const entry = makeMultiDistEntry()
    expect(isAgentAvailableForPlatform(entry, 'darwin-aarch64')).toBe(true)
  })

  it('returns true for multi-dist agent when binary doesnt match but npx exists', () => {
    const entry = makeMultiDistEntry()
    expect(isAgentAvailableForPlatform(entry, 'windows-x86_64')).toBe(true)
  })

  it('returns false for agent with empty distribution', () => {
    const entry = makeNpxEntry({ distribution: {} })
    expect(isAgentAvailableForPlatform(entry, 'darwin-aarch64')).toBe(false)
  })

  it('returns false when platformKey is null', () => {
    const entry = makeNpxEntry()
    expect(isAgentAvailableForPlatform(entry, null)).toBe(true) // npx works without platform
  })

  it('returns false for binary-only agent when platformKey is null', () => {
    const entry = makeBinaryEntry()
    expect(isAgentAvailableForPlatform(entry, null)).toBe(false)
  })
})

describe('getPreferredDistribution', () => {
  it('returns binary when available for platform', () => {
    const dist: RegistryDistribution = {
      binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } },
      npx: { package: '@test/a@1.0.0' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result).toEqual({ type: 'binary', target: dist.binary!['darwin-aarch64'] })
  })

  it('falls back to npx when binary not available for platform', () => {
    const dist: RegistryDistribution = {
      binary: { 'linux-x86_64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } },
      npx: { package: '@test/a@1.0.0' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result).toEqual({ type: 'npx', target: dist.npx! })
  })

  it('returns npx when no binary exists', () => {
    const dist: RegistryDistribution = {
      npx: { package: '@test/a@1.0.0' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result).toEqual({ type: 'npx', target: dist.npx! })
  })

  it('returns uvx when only uvx exists', () => {
    const dist: RegistryDistribution = {
      uvx: { package: 'fast-agent@0.6.10' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result).toEqual({ type: 'uvx', target: dist.uvx! })
  })

  it('prefers binary over npx over uvx', () => {
    const dist: RegistryDistribution = {
      binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } },
      npx: { package: '@test/a@1.0.0' },
      uvx: { package: 'test-agent@1.0.0' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result?.type).toBe('binary')
  })

  it('prefers npx over uvx when no binary for platform', () => {
    const dist: RegistryDistribution = {
      npx: { package: '@test/a@1.0.0' },
      uvx: { package: 'test-agent@1.0.0' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result?.type).toBe('npx')
  })

  it('returns null for empty distribution', () => {
    const dist: RegistryDistribution = {}
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result).toBeNull()
  })

  it('returns null when binary is only option but platform not supported', () => {
    const dist: RegistryDistribution = {
      binary: { 'linux-x86_64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result).toBeNull()
  })

  it('handles null platformKey — skips binary, returns npx', () => {
    const dist: RegistryDistribution = {
      binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } },
      npx: { package: '@test/a@1.0.0' },
    }
    const result = getPreferredDistribution(dist, null)
    expect(result?.type).toBe('npx')
  })

  it('returns remote when remote distribution exists', () => {
    const dist: RegistryDistribution = {
      remote: { url: 'wss://example.com/ws', transport: 'websocket' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result).toEqual({ type: 'remote', target: dist.remote! })
  })

  it('prefers remote over all other types', () => {
    const dist: RegistryDistribution = {
      remote: { url: 'wss://example.com/ws', transport: 'websocket' },
      binary: { 'darwin-aarch64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } },
      npx: { package: '@test/a@1.0.0' },
    }
    const result = getPreferredDistribution(dist, 'darwin-aarch64')
    expect(result?.type).toBe('remote')
  })
})

describe('isAgentAvailableForPlatform — remote', () => {
  it('returns true for remote agent on any platform', () => {
    const entry = makeNpxEntry({
      distribution: { remote: { url: 'wss://example.com/ws', transport: 'websocket' } },
    })
    expect(isAgentAvailableForPlatform(entry, 'darwin-aarch64')).toBe(true)
    expect(isAgentAvailableForPlatform(entry, null)).toBe(true)
  })
})
