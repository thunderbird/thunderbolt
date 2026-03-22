import {
  AgentSideConnection,
  ClientSideConnection,
  type Agent,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { SessionUpdateHandler } from './types'

type CreateAcpClientOptions = {
  stream: Stream
  agentStream: Stream
  agentHandler: (conn: AgentSideConnection) => Agent
  onSessionUpdate: SessionUpdateHandler
}

type AcpClientResult = {
  connection: ClientSideConnection
  agentConnection: AgentSideConnection
}

/**
 * Creates an ACP client connected to an agent.
 * Sets up both client-side and agent-side connections over the provided streams.
 *
 * @param options.stream - The client-side stream for communication
 * @param options.agentStream - The agent-side stream for communication
 * @param options.agentHandler - The agent handler function (e.g., from createBuiltInAgentHandler)
 * @param options.onSessionUpdate - Callback invoked when the agent sends session updates
 */
export const createAcpClient = (options: CreateAcpClientOptions): AcpClientResult => {
  const { stream, agentStream, agentHandler, onSessionUpdate } = options

  const agentConnection = new AgentSideConnection(agentHandler, agentStream)

  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => {
        onSessionUpdate(params.update)
      },
      requestPermission: async () => ({ outcome: 'cancelled' as const }),
    }),
    stream,
  )

  return { connection, agentConnection }
}
