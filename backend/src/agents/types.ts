import type { RemoteAgentDescriptor } from '@shared/agent-types'

export type { RemoteAgentDescriptor }

export type AgentProvider = {
  getAgents: () => RemoteAgentDescriptor[]
}
