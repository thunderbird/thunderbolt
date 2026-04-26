// ACP Client
export { createAcpClient, type AcpClient } from './client'

// Built-in Agent
export { createBuiltInAgent } from './built-in-agent'

// Stream Adapters
export { createInProcessStreams } from './streams'
export { createStdioStream, isAgentAvailable } from './stdio-stream'
export type { SubprocessHandle, SubprocessSpawner } from './stdio-stream'
export { createWebSocketStream } from './websocket-stream'
export type { WebSocketLike } from './websocket-stream'

// Agent Connections
export { connectToLocalAgent } from './local-agent'
export { connectToRemoteAgent } from './remote-agent'

// Session Adapters
export {
  extractModelConfig,
  modeFromAcpSession,
  modeFromSessionMode,
  modelFromAcpSession,
  modelFromConfigOption,
} from './session-adapters'

// Types
export type { AgentConfig, AgentSessionState, AgentTransport, AgentType } from './types'
