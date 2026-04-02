import type { Stream } from '@agentclientprotocol/sdk'
import type { AgentConfig } from './types'
import { connectWithReconnect, createWebSocketStream, type WebSocketLike } from './websocket-stream'
import { fetchWsTicket, appendTicketToUrl } from './ws-ticket'

type WebSocketFactory = (url: string) => WebSocketLike

type RemoteAgentConnectionOptions = {
  agentConfig: AgentConfig
  createWebSocket?: WebSocketFactory
  onStream: (stream: Stream) => void
  onDisconnected: () => void
}

/**
 * Default WebSocket factory that fetches a one-time auth ticket
 * before each connection and appends it to the URL.
 */
const ticketedWebSocketFactory = async (url: string): Promise<WebSocketLike> => {
  try {
    const ticket = await fetchWsTicket()
    return new WebSocket(appendTicketToUrl(url, ticket)) as unknown as WebSocketLike
  } catch {
    // If ticket fetch fails (e.g., not logged in), connect without ticket
    return new WebSocket(url) as unknown as WebSocketLike
  }
}

/**
 * Connect to a remote ACP agent over WebSocket with automatic reconnection.
 * Fetches a fresh auth ticket before each connection attempt (default behavior).
 * Calls onStream on initial connect and every successful reconnect.
 * Calls onDisconnected when all retries are exhausted.
 */
export const connectToRemoteAgent = ({
  agentConfig,
  createWebSocket,
  onStream,
  onDisconnected,
}: RemoteAgentConnectionOptions): { disconnect: () => void } => {
  const url = agentConfig.url
  if (!url) {
    throw new Error(`Agent "${agentConfig.name}" has no URL configured`)
  }

  // If a custom factory is provided (e.g., tests), use it directly.
  // Otherwise use the ticketed factory for real connections.
  const factory = createWebSocket ? () => createWebSocket(url) : () => ticketedWebSocketFactory(url)

  let currentWs: WebSocketLike | null = null

  const { cancel } = connectWithReconnect({
    createWebSocket: factory,
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
      cancel()
      currentWs?.close()
      currentWs = null
    },
  }
}
