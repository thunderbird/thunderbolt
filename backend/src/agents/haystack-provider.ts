import type { AgentProvider, RemoteAgentDescriptor } from './types'
import type { HaystackPipelineConfig } from '@/haystack/types'

export const createHaystackProvider = (pipelines: HaystackPipelineConfig[], wsBaseUrl: string): AgentProvider => ({
  getAgents: (): RemoteAgentDescriptor[] =>
    pipelines.map((p) => ({
      id: `agent-haystack-${p.slug}`,
      name: p.name,
      type: 'remote',
      transport: 'websocket',
      url: `${wsBaseUrl}/haystack/ws/${p.slug}`,
      icon: p.icon ?? 'file-search',
      isSystem: 1,
      enabled: 1,
    })),
})
