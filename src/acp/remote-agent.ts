import type { Stream } from '@agentclientprotocol/sdk'
import type { AgentConfig } from './types'
import { connectWithReconnect, createWebSocketStream, type WebSocketLike } from './websocket-stream'

type WebSocketFactory = (url: string) => WebSocketLike

type RemoteAgentConnectionOptions = {
  agentConfig: AgentConfig
  createWebSocket?: WebSocketFactory
  onStream: (stream: Stream) => void
  onDisconnected: () => void
}

const defaultWebSocketFactory: WebSocketFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike

/**
 * Connect to a remote ACP agent over WebSocket with automatic reconnection.
 * Calls onStream on initial connect and every successful reconnect.
 * Calls onDisconnected when all retries are exhausted.
 */
export const connectToRemoteAgent = ({
  agentConfig,
  createWebSocket = defaultWebSocketFactory,
  onStream,
  onDisconnected,
}: RemoteAgentConnectionOptions): { disconnect: () => void } => {
  const url = agentConfig.url
  if (!url) {
    throw new Error(`Agent "${agentConfig.name}" has no URL configured`)
  }

  let currentWs: WebSocketLike | null = null

  connectWithReconnect({
    createWebSocket: () => createWebSocket(url),
    onConnect: (ws) => {
      currentWs = ws
      const stream = createWebSocketStream(ws)
      onStream(stream)
    },
    onGiveUp: () => {
      currentWs = null
      onDisconnected()
    },
  })

  return {
    disconnect: () => {
      currentWs?.close()
      currentWs = null
    },
  }
}
