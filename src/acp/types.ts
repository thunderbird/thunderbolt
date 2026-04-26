import type { SessionConfigOption, SessionMode } from '@agentclientprotocol/sdk'

export type AgentTransport = 'in-process' | 'stdio' | 'websocket'
export type AgentType = 'built-in' | 'local' | 'remote'

export type AgentConfig = {
  id: string
  name: string
  type: AgentType
  transport: AgentTransport
  command?: string
  args?: string[]
  url?: string
  authMethod?: string
  icon?: string
  isSystem: boolean
  enabled: boolean
  distributionType?: string
  installPath?: string
  packageName?: string
}

export type AgentSessionState = {
  sessionId: string
  availableModes: SessionMode[]
  currentModeId: string | null
  configOptions: SessionConfigOption[]
}
