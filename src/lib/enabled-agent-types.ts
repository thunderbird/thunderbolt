import type { AgentType } from '@/acp/types'

const allAgentTypes = ['built-in', 'local', 'remote'] as const satisfies readonly AgentType[]

export const parseEnabledAgentTypes = (raw: string | undefined): Set<AgentType> => {
  if (!raw) {
    return new Set(allAgentTypes)
  }
  const types = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is AgentType => allAgentTypes.includes(t as AgentType))
  return new Set(types)
}

const enabledTypes = parseEnabledAgentTypes(import.meta.env.VITE_ENABLED_AGENT_TYPES as string | undefined)

/** Check if an agent type is enabled via VITE_ENABLED_AGENT_TYPES */
export const isAgentTypeEnabled = (type: AgentType): boolean => enabledTypes.has(type)
