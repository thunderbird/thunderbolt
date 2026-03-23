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

export const defaultAgentBuiltIn: Agent = {
  id: 'agent-built-in',
  name: 'Thunderbolt',
  type: 'built-in',
  transport: 'in-process',
  command: null,
  args: null,
  url: null,
  authMethod: null,
  icon: 'zap',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultAgentClaudeCode: Agent = {
  id: 'agent-claude-code',
  name: 'Claude Code',
  type: 'local',
  transport: 'stdio',
  command: 'claude-agent-acp',
  args: null,
  url: null,
  authMethod: null,
  icon: 'terminal',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

export const defaultAgentCodex: Agent = {
  id: 'agent-codex',
  name: 'Codex',
  type: 'local',
  transport: 'stdio',
  command: 'codex',
  args: JSON.stringify(['--acp']),
  url: null,
  authMethod: null,
  icon: 'code',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
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

/**
 * Create an Agent record for a Haystack pipeline discovered from the backend.
 */
export const haystackAgentFromPipeline = (
  pipeline: { slug: string; name: string; icon?: string },
  wsBaseUrl: string,
): Agent => ({
  id: `agent-haystack-${pipeline.slug}`,
  name: pipeline.name,
  type: 'remote',
  transport: 'websocket',
  command: null,
  args: null,
  url: `${wsBaseUrl}/haystack/ws/${pipeline.slug}`,
  authMethod: null,
  icon: pipeline.icon ?? 'file-search',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  defaultHash: null,
  userId: null,
})
