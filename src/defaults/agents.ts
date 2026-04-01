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

/**
 * Canonical list of supported local CLI agents.
 * Add new entries here to extend local agent discovery.
 */
export const SUPPORTED_LOCAL_AGENTS = [
  { name: 'Claude Code', command: 'claude-agent-acp', args: [] as string[] },
  { name: 'Codex', command: 'codex', args: ['--acp'] },
] as const

const agentDefaults = {
  url: null,
  authMethod: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
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

export const defaultAgentClaudeCode: Agent = {
  id: 'agent-claude-code',
  name: 'Claude Code',
  type: 'local',
  transport: 'stdio',
  command: 'claude-agent-acp',
  args: null,
  icon: 'terminal',
  ...agentDefaults,
}

export const defaultAgentCodex: Agent = {
  id: 'agent-codex',
  name: 'Codex',
  type: 'local',
  transport: 'stdio',
  command: 'codex',
  args: JSON.stringify(['--acp']),
  icon: 'code',
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
 * These are NOT seeded into the DB — they're added only when detected on PATH.
 */
export const localAgentCandidates: ReadonlyArray<Agent> = [defaultAgentClaudeCode, defaultAgentCodex] as const
