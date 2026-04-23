export type AgentDescriptor = {
  id: string
  name: string
  type: 'built-in' | 'local' | 'remote'
  transport: 'in-process' | 'stdio' | 'websocket'
  url?: string
  icon?: string
  isSystem?: number
}

export type AgentProvider = {
  getAgents: () => Promise<AgentDescriptor[]>
}
