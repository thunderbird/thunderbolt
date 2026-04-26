import type { RegistryEntry } from '@/acp/registry'
import type { Agent } from '@/types'

// ── Merged agent type ─────────────────────────────────────────────────────────

export type MergedAgent = {
  registryId: string
  agentId: string | null
  name: string
  description: string
  version: string
  installedVersion: string | null
  updateAvailable: boolean
  isInstalled: boolean
  isCustom: boolean
  isRemote: boolean
  isBuiltIn: boolean
  enabled: boolean
  distributionType: string | null
  icon: string | null
  authors: string[]
  license: string
  registryEntry: RegistryEntry | null
}

// ── Merge logic ───────────────────────────────────────────────────────────────

/**
 * Merges registry entries with installed agents from the database.
 * Registry agents get install state from DB. Custom agents get appended.
 */
export const mergeRegistryWithInstalled = (
  registryEntries: RegistryEntry[],
  installedAgents: Agent[],
): MergedAgent[] => {
  // Index installed agents by both registryId and id (remote agents use id-based matching)
  const installedByRegistryId = new Map<string, Agent>()
  const installedById = new Map<string, Agent>()
  const customAgents: Agent[] = []
  const builtInAgents: Agent[] = []

  for (const agent of installedAgents) {
    if (agent.type === 'built-in') {
      builtInAgents.push(agent)
    } else if (agent.registryId) {
      installedByRegistryId.set(agent.registryId, agent)
    } else if (!agent.isSystem && !agent.registryId) {
      customAgents.push(agent)
    }
    installedById.set(agent.id, agent)
  }

  const merged: MergedAgent[] = registryEntries.map((entry) => {
    // Match by registryId first, then fall back to id (for remote agents seeded with matching id)
    const installed = installedByRegistryId.get(entry.id) ?? installedById.get(entry.id)
    const installedVersion = installed?.installedVersion ?? null
    const isRemote = !!entry.distribution.remote

    return {
      registryId: entry.id,
      agentId: installed?.id ?? null,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      installedVersion,
      updateAvailable: installedVersion !== null && installedVersion !== entry.version,
      isInstalled: installed !== undefined || isRemote,
      isCustom: false,
      isRemote,
      isBuiltIn: false,
      enabled: installed ? installed.enabled === 1 : isRemote,
      distributionType: getPreferredDistType(entry),
      icon: entry.icon ?? null,
      authors: entry.authors,
      license: entry.license,
      registryEntry: entry,
    }
  })

  // Prepend built-in agents
  for (const agent of builtInAgents) {
    merged.push({
      registryId: agent.id,
      agentId: agent.id,
      name: agent.name ?? 'Thunderbolt',
      description: agent.description ?? 'Built-in AI assistant',
      version: '',
      installedVersion: null,
      updateAvailable: false,
      isInstalled: true,
      isCustom: false,
      isRemote: false,
      isBuiltIn: true,
      enabled: agent.enabled === 1,
      distributionType: 'built-in',
      icon: agent.icon ?? 'zap',
      authors: [],
      license: '',
      registryEntry: null,
    })
  }

  // Append user-added agents (custom local + custom remote)
  for (const agent of customAgents) {
    const isRemote = agent.type === 'remote'
    merged.push({
      registryId: agent.id,
      agentId: agent.id,
      name: agent.name ?? 'Unknown',
      description: agent.description ?? '',
      version: '',
      installedVersion: null,
      updateAvailable: false,
      isInstalled: true,
      isCustom: true,
      isRemote,
      isBuiltIn: false,
      enabled: agent.enabled === 1,
      distributionType: agent.distributionType ?? (isRemote ? 'remote' : 'custom'),
      icon: agent.icon ?? null,
      authors: [],
      license: '',
      registryEntry: null,
    })
  }

  return merged
}

const getPreferredDistType = (entry: RegistryEntry): string | null => {
  if (entry.distribution.remote) {
    return 'remote'
  }
  if (entry.distribution.binary) {
    return 'binary'
  }
  if (entry.distribution.npx) {
    return 'npx'
  }
  if (entry.distribution.uvx) {
    return 'uvx'
  }
  return null
}

// ── Filtering ─────────────────────────────────────────────────────────────────

export const filterAgents = (agents: MergedAgent[], query: string): MergedAgent[] => {
  if (!query.trim()) {
    return agents
  }
  const lower = query.toLowerCase()
  return agents.filter((a) => a.name.toLowerCase().includes(lower) || a.description.toLowerCase().includes(lower))
}

// ── Status filtering ──────────────────────────────────────────────────────

export type AgentStatusFilter = 'all' | 'available' | 'installed' | 'not-installed'

export const filterByStatus = (
  agents: MergedAgent[],
  status: AgentStatusFilter,
  canInstallLocal: boolean,
): MergedAgent[] => {
  switch (status) {
    case 'all':
      return agents
    case 'installed':
      return agents.filter((a) => a.isInstalled)
    case 'not-installed':
      return agents.filter((a) => !a.isInstalled)
    case 'available':
      if (canInstallLocal) {
        return agents
      }
      return agents.filter((a) => a.isRemote || a.isBuiltIn)
  }
}

// ── Sorting ───────────────────────────────────────────────────────────────────

export const sortAgents = (agents: MergedAgent[]): MergedAgent[] =>
  [...agents].sort((a, b) => {
    // Built-in first
    if (a.isBuiltIn !== b.isBuiltIn) {
      return a.isBuiltIn ? -1 : 1
    }
    // Then installed before uninstalled
    if (a.isInstalled !== b.isInstalled) {
      return a.isInstalled ? -1 : 1
    }
    // Then alphabetical
    return a.name.localeCompare(b.name)
  })

// ── Section grouping ──────────────────────────────────────────────────────────

export type AgentSections = {
  installed: MergedAgent[]
  available: MergedAgent[]
  unavailable: MergedAgent[]
}

/**
 * Groups agents into sections: Installed, Available (can install on this device),
 * and Unavailable (requires a different platform).
 */
export const groupAgentsBySection = (agents: MergedAgent[], canInstallLocal: boolean): AgentSections => {
  const installed: MergedAgent[] = []
  const available: MergedAgent[] = []
  const unavailable: MergedAgent[] = []

  for (const agent of agents) {
    if (agent.isInstalled) {
      installed.push(agent)
    } else if (canInstallLocal || agent.isRemote) {
      available.push(agent)
    } else {
      unavailable.push(agent)
    }
  }

  return { installed, available, unavailable }
}

// ── Distribution label ────────────────────────────────────────────────────────

export const getDistributionLabel = (type: string | null | undefined): string => {
  switch (type) {
    case 'npx':
      return 'Node.js'
    case 'binary':
      return 'Binary'
    case 'uvx':
      return 'Python'
    case 'remote':
      return 'Remote'
    case 'custom':
      return 'Custom'
    case 'built-in':
      return 'Built-in'
    default:
      return ''
  }
}

/** Returns true if the distribution type requires local installation (desktop only). */
export const isLocalDistribution = (type: string | null | undefined): boolean =>
  type === 'npx' || type === 'binary' || type === 'uvx'
