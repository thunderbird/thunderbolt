import { hashValues } from '@/lib/utils'
import type { Agent } from '@/types'

/**
 * Compute hash of user-editable fields for an agent
 */
export const hashAgent = (agent: Agent): string => {
  return hashValues([
    agent.name,
    agent.type,
    agent.transport,
    agent.command,
    agent.args,
    agent.url,
    agent.icon,
    agent.enabled,
    agent.deletedAt,
  ])
}

const agentDefaults = {
  url: null,
  authMethod: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  description: null,
  registryId: null,
  installedVersion: null,
  registryVersion: null,
  distributionType: null,
  installPath: null,
  packageName: null,
} as const

export const defaultAgentBuiltIn: Agent = {
  id: 'agent-built-in',
  name: 'Thunderbolt',
  type: 'built-in',
  transport: 'in-process',
  command: null,
  args: null,
  icon: 'zap',
  ...agentDefaults,
}

/**
 * Agents seeded into the database on all platforms.
 * Only the built-in agent is seeded — local agents are installed
 * from the ACP registry or added as custom agents by the user.
 */
export const defaultAgents: ReadonlyArray<Agent> = [defaultAgentBuiltIn] as const
