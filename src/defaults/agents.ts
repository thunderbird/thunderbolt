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
} as const

type LocalAgentSpec = {
  id: string
  name: string
  command: string
  args: string[] | null
  icon: string
}

/**
 * Canonical list of supported local CLI agents.
 * Add new entries here to extend local agent discovery — each entry maps to a DB Agent.
 */
export const supportedLocalAgents: ReadonlyArray<LocalAgentSpec> = [
  { id: 'agent-claude-code', name: 'Claude Code', command: 'claude-agent-acp', args: null, icon: 'terminal' },
  { id: 'agent-codex', name: 'Codex', command: 'codex', args: ['--acp'], icon: 'code' },
]

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
 * Only the built-in agent is seeded — local CLI agents (Claude Code, Codex)
 * are discovered at runtime on desktop via the Tauri shell plugin.
 */
export const defaultAgents: ReadonlyArray<Agent> = [defaultAgentBuiltIn] as const

/**
 * Local CLI agent candidates for runtime discovery on desktop.
 * Derived from supportedLocalAgents — not seeded into the DB directly,
 * only added when the command is detected on PATH.
 */
export const localAgentCandidates: ReadonlyArray<Agent> = supportedLocalAgents.map((entry) => ({
  ...agentDefaults,
  id: entry.id,
  name: entry.name,
  type: 'local' as const,
  transport: 'stdio' as const,
  command: entry.command,
  args: Array.isArray(entry.args) ? JSON.stringify(entry.args) : entry.args,
  icon: entry.icon,
}))
