import { describe, expect, it, mock, beforeEach } from 'bun:test'
import type { RegistryEntry } from '@/acp/registry'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRegistryEntries: RegistryEntry[] = [
  {
    id: 'claude-acp',
    name: 'Claude Agent',
    version: '0.24.2',
    description: 'Claude Code ACP adapter',
    authors: ['Anthropic'],
    license: 'MIT',
    distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.24.2' } },
    icon: 'https://cdn.example.com/claude.svg',
  },
  {
    id: 'goose',
    name: 'goose',
    version: '1.29.0',
    description: 'Block goose agent',
    authors: ['Block'],
    license: 'Apache-2.0',
    distribution: {
      binary: {
        'darwin-aarch64': { archive: 'https://example.com/goose.tar.gz', cmd: './goose' },
      },
    },
  },
  {
    id: 'fast-agent',
    name: 'fast-agent',
    version: '0.6.10',
    description: 'Fast agent for Python',
    authors: ['FastAgent'],
    license: 'MIT',
    distribution: { uvx: { package: 'fast-agent@0.6.10' } },
  },
]

mock.module('@tauri-apps/plugin-os', () => ({
  platform: () => 'macos',
  arch: () => 'aarch64',
}))

import { tauriCoreMock } from '@/test-utils/tauri-mock'

mock.module('@tauri-apps/api/core', () => tauriCoreMock)

import { webPlatformMock } from '@/test-utils/platform-mock'

mock.module('@/lib/platform', () => ({ ...webPlatformMock, getPlatform: () => 'macos' }))

// ── Tests ─────────────────────────────────────────────────────────────────────

import {
  mergeRegistryWithInstalled,
  filterAgents,
  sortAgents,
  getDistributionLabel,
  isLocalDistribution,
} from './use-agent-registry'

describe('use-agent-registry utilities', () => {
  describe('mergeRegistryWithInstalled', () => {
    it('marks registry agents as not installed when no DB agents exist', () => {
      const result = mergeRegistryWithInstalled(mockRegistryEntries, [])
      expect(result).toHaveLength(3)
      expect(result.every((a) => !a.isInstalled)).toBe(true)
    })

    it('marks matching agents as installed based on registryId', () => {
      const installed = [
        {
          id: 'agent-registry-claude-acp',
          name: 'Claude Agent',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          registryId: 'claude-acp',
          installedVersion: '0.24.2',
          registryVersion: '0.24.2',
        },
      ]
      const result = mergeRegistryWithInstalled(mockRegistryEntries, installed as any)
      const claude = result.find((a) => a.registryId === 'claude-acp')
      expect(claude?.isInstalled).toBe(true)
      expect(claude?.installedVersion).toBe('0.24.2')
      expect(claude?.enabled).toBe(true)
    })

    it('detects update available when versions differ', () => {
      const installed = [
        {
          id: 'agent-registry-claude-acp',
          name: 'Claude Agent',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          registryId: 'claude-acp',
          installedVersion: '0.23.0',
          registryVersion: '0.24.2',
        },
      ]
      const result = mergeRegistryWithInstalled(mockRegistryEntries, installed as any)
      const claude = result.find((a) => a.registryId === 'claude-acp')
      expect(claude?.updateAvailable).toBe(true)
    })

    it('includes custom agents that are not in the registry', () => {
      const installed = [
        {
          id: 'custom-agent-1',
          name: 'My Custom Agent',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          registryId: null,
          distributionType: 'custom',
        },
      ]
      const result = mergeRegistryWithInstalled(mockRegistryEntries, installed as any)
      // 3 registry + 1 custom
      expect(result).toHaveLength(4)
      const custom = result.find((a) => a.agentId === 'custom-agent-1')
      expect(custom?.isInstalled).toBe(true)
      expect(custom?.isCustom).toBe(true)
    })
  })

  describe('filterAgents', () => {
    it('returns all agents for empty search', () => {
      const agents = mergeRegistryWithInstalled(mockRegistryEntries, [])
      const result = filterAgents(agents, '')
      expect(result).toHaveLength(3)
    })

    it('filters by name case-insensitive', () => {
      const agents = mergeRegistryWithInstalled(mockRegistryEntries, [])
      const result = filterAgents(agents, 'claude')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Claude Agent')
    })

    it('filters by description case-insensitive', () => {
      const agents = mergeRegistryWithInstalled(mockRegistryEntries, [])
      const result = filterAgents(agents, 'python')
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('fast-agent')
    })

    it('returns empty for no matches', () => {
      const agents = mergeRegistryWithInstalled(mockRegistryEntries, [])
      const result = filterAgents(agents, 'zzzznonexistent')
      expect(result).toHaveLength(0)
    })
  })

  describe('sortAgents', () => {
    it('sorts installed agents before uninstalled', () => {
      const agents = mergeRegistryWithInstalled(mockRegistryEntries, [
        {
          id: 'agent-registry-goose',
          name: 'goose',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          registryId: 'goose',
          installedVersion: '1.29.0',
        },
      ] as any)

      const sorted = sortAgents(agents)
      expect(sorted[0].name).toBe('goose')
      expect(sorted[0].isInstalled).toBe(true)
    })

    it('sorts alphabetically within each group', () => {
      const agents = mergeRegistryWithInstalled(mockRegistryEntries, [])
      const sorted = sortAgents(agents)
      // All uninstalled, sorted alphabetically
      expect(sorted[0].name).toBe('Claude Agent')
      expect(sorted[1].name).toBe('fast-agent')
      expect(sorted[2].name).toBe('goose')
    })
  })

  describe('getDistributionLabel', () => {
    it('returns "NPX" for npx type', () => {
      expect(getDistributionLabel('npx')).toBe('Node.js')
    })

    it('returns "Binary" for binary type', () => {
      expect(getDistributionLabel('binary')).toBe('Binary')
    })

    it('returns "Python" for uvx type', () => {
      expect(getDistributionLabel('uvx')).toBe('Python')
    })

    it('returns "Custom" for custom type', () => {
      expect(getDistributionLabel('custom')).toBe('Custom')
    })

    it('returns "Remote" for remote type', () => {
      expect(getDistributionLabel('remote')).toBe('Remote')
    })

    it('returns empty string for undefined', () => {
      expect(getDistributionLabel(undefined)).toBe('')
    })
  })

  describe('isLocalDistribution', () => {
    it('returns true for npx', () => {
      expect(isLocalDistribution('npx')).toBe(true)
    })

    it('returns true for binary', () => {
      expect(isLocalDistribution('binary')).toBe(true)
    })

    it('returns true for uvx', () => {
      expect(isLocalDistribution('uvx')).toBe(true)
    })

    it('returns false for remote', () => {
      expect(isLocalDistribution('remote')).toBe(false)
    })

    it('returns false for custom', () => {
      expect(isLocalDistribution('custom')).toBe(false)
    })

    it('returns false for undefined', () => {
      expect(isLocalDistribution(undefined)).toBe(false)
    })
  })

  describe('mergeRegistryWithInstalled — built-in agents', () => {
    it('includes built-in agents from DB at the top', () => {
      const builtIn = [
        {
          id: 'agent-built-in',
          name: 'Thunderbolt',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 1,
          isSystem: 1,
          icon: 'zap',
        },
      ]
      const result = mergeRegistryWithInstalled(mockRegistryEntries, builtIn as any)
      const tb = result.find((a) => a.agentId === 'agent-built-in')
      expect(tb).toBeDefined()
      expect(tb?.name).toBe('Thunderbolt')
      expect(tb?.isInstalled).toBe(true)
      expect(tb?.isBuiltIn).toBe(true)
    })

    it('marks built-in agent as not uninstallable', () => {
      const builtIn = [
        {
          id: 'agent-built-in',
          name: 'Thunderbolt',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 1,
          isSystem: 1,
        },
      ]
      const result = mergeRegistryWithInstalled(mockRegistryEntries, builtIn as any)
      const tb = result.find((a) => a.agentId === 'agent-built-in')
      expect(tb?.isBuiltIn).toBe(true)
    })

    it('reflects enabled state of built-in agent', () => {
      const builtIn = [
        {
          id: 'agent-built-in',
          name: 'Thunderbolt',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 0,
          isSystem: 1,
        },
      ]
      const result = mergeRegistryWithInstalled(mockRegistryEntries, builtIn as any)
      const tb = result.find((a) => a.agentId === 'agent-built-in')
      expect(tb?.enabled).toBe(false)
    })
  })

  describe('sortAgents — built-in first', () => {
    it('sorts built-in agents before installed, before uninstalled', () => {
      const builtIn = [
        {
          id: 'agent-built-in',
          name: 'Thunderbolt',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 1,
          isSystem: 1,
        },
      ]
      const installed = [
        {
          id: 'agent-registry-goose',
          name: 'goose',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          registryId: 'goose',
          installedVersion: '1.29.0',
        },
      ]
      const result = mergeRegistryWithInstalled(mockRegistryEntries, [...builtIn, ...installed] as any)
      const sorted = sortAgents(result)
      expect(sorted[0].name).toBe('Thunderbolt')
      expect(sorted[0].isBuiltIn).toBe(true)
      expect(sorted[1].name).toBe('goose')
      expect(sorted[1].isInstalled).toBe(true)
    })
  })

  describe('filterByStatus', () => {
    let filterByStatus: typeof import('./use-agent-registry').filterByStatus

    beforeEach(async () => {
      const mod = await import('./use-agent-registry')
      filterByStatus = mod.filterByStatus
    })

    const agents = (): import('./use-agent-registry').MergedAgent[] => {
      const installed = [
        {
          id: 'agent-registry-claude-acp',
          name: 'Claude Agent',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          registryId: 'claude-acp',
          installedVersion: '0.24.2',
        },
      ]
      return mergeRegistryWithInstalled(mockRegistryEntries, installed as any)
    }

    it('returns all agents for "all" filter', () => {
      const result = filterByStatus(agents(), 'all', false)
      expect(result).toHaveLength(3)
    })

    it('returns only installed agents for "installed" filter', () => {
      const result = filterByStatus(agents(), 'installed', false)
      expect(result.every((a) => a.isInstalled)).toBe(true)
      expect(result).toHaveLength(1)
    })

    it('returns only non-installed agents for "not-installed" filter', () => {
      const result = filterByStatus(agents(), 'not-installed', false)
      expect(result.every((a) => !a.isInstalled)).toBe(true)
      expect(result).toHaveLength(2)
    })

    it('returns all agents for "available" on desktop (all are available)', () => {
      const result = filterByStatus(agents(), 'available', true)
      expect(result).toHaveLength(3)
    })

    it('returns only remote/built-in agents for "available" on web', () => {
      // On web, only remote agents are "available" (can actually be used)
      const withRemote = mergeRegistryWithInstalled(
        [
          ...mockRegistryEntries,
          {
            id: 'remote-agent',
            name: 'Remote',
            version: '1.0.0',
            description: 'A remote agent',
            authors: [],
            license: 'MIT',
            distribution: { remote: { url: 'wss://example.com/ws', transport: 'websocket' } },
          },
        ],
        [],
      )
      const result = filterByStatus(withRemote, 'available', false)
      // Only the remote agent is available on web
      expect(result.every((a) => a.isRemote || a.isBuiltIn)).toBe(true)
    })
  })

  describe('groupAgentsBySection', () => {
    let groupAgentsBySection: typeof import('./use-agent-registry').groupAgentsBySection

    beforeEach(async () => {
      const mod = await import('./use-agent-registry')
      groupAgentsBySection = mod.groupAgentsBySection
    })

    it('puts built-in and installed agents in "Installed" section', () => {
      const builtIn = [
        {
          id: 'agent-built-in',
          name: 'Thunderbolt',
          type: 'built-in' as const,
          transport: 'in-process' as const,
          enabled: 1,
          isSystem: 1,
        },
      ]
      const installed = [
        {
          id: 'agent-registry-claude-acp',
          name: 'Claude',
          type: 'local' as const,
          transport: 'stdio' as const,
          enabled: 1,
          registryId: 'claude-acp',
          installedVersion: '0.24.2',
        },
      ]
      const merged = mergeRegistryWithInstalled(mockRegistryEntries, [...builtIn, ...installed] as any)
      const groups = groupAgentsBySection(merged, true)
      expect(groups.installed.length).toBe(2) // built-in + claude
    })

    it('puts uninstalled agents with compatible platform in "Available" section', () => {
      const merged = mergeRegistryWithInstalled(mockRegistryEntries, [])
      const groups = groupAgentsBySection(merged, true)
      // On desktop, all uninstalled agents are "available"
      expect(groups.available.length).toBe(3)
      expect(groups.unavailable.length).toBe(0)
    })

    it('puts local agents in "Unavailable" on web', () => {
      const merged = mergeRegistryWithInstalled(mockRegistryEntries, [])
      const groups = groupAgentsBySection(merged, false)
      // On web, local agents (npx/binary/uvx) are unavailable
      expect(groups.unavailable.length).toBe(3)
      expect(groups.available.length).toBe(0)
    })

    it('remote agents go to "Available" even on web', () => {
      const withRemote = mergeRegistryWithInstalled(
        [
          ...mockRegistryEntries,
          {
            id: 'remote-agent',
            name: 'Remote',
            version: '1.0.0',
            description: '',
            authors: [],
            license: 'MIT',
            distribution: { remote: { url: 'wss://example.com/ws', transport: 'websocket' } },
          },
        ],
        [],
      )
      const groups = groupAgentsBySection(withRemote, false)
      const remoteInAvailable = groups.installed.find((a) => a.name === 'Remote')
      // Remote agents are auto-installed, so they appear in installed
      expect(remoteInAvailable).toBeDefined()
    })

    it('returns empty arrays when no agents', () => {
      const groups = groupAgentsBySection([], true)
      expect(groups.installed).toHaveLength(0)
      expect(groups.available).toHaveLength(0)
      expect(groups.unavailable).toHaveLength(0)
    })
  })

  describe('mergeRegistryWithInstalled — remote agents', () => {
    const remoteEntry: RegistryEntry = {
      id: 'agent-haystack-docs',
      name: 'Docs Pipeline',
      version: '1.0.0',
      description: 'Haystack RAG pipeline',
      authors: [],
      license: 'proprietary',
      distribution: {
        remote: { url: 'wss://example.com/ws/docs', transport: 'websocket' },
      },
    }

    it('marks remote agents as installed and remote', () => {
      const result = mergeRegistryWithInstalled([remoteEntry], [])
      expect(result).toHaveLength(1)
      expect(result[0].isInstalled).toBe(true)
      expect(result[0].isRemote).toBe(true)
      expect(result[0].distributionType).toBe('remote')
    })

    it('remote agents are always enabled', () => {
      const result = mergeRegistryWithInstalled([remoteEntry], [])
      expect(result[0].enabled).toBe(true)
    })
  })
})
