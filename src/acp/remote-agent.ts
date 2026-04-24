import type { Stream } from '@agentclientprotocol/sdk'
import { HTTPError } from 'ky'
import type { AgentConfig } from './types'
import { connectWithReconnect, createWebSocketStream, type WebSocketLike } from './websocket-stream'
import { fetchWsTicket, appendTicketToUrl } from './ws-ticket'

type WebSocketFactory = (url: string) => WebSocketLike

type RemoteAgentConnectionOptions = {
  agentConfig: AgentConfig
  createWebSocket?: WebSocketFactory
  ticketPayload?: Record<string, unknown>
  onStream: (stream: Stream) => void
  onDisconnected: () => void
}

/**
 * Default WebSocket factory that fetches a one-time auth ticket
 * before each connection and appends it to the URL.
 */
const ticketedWebSocketFactory = async (
  url: string,
  ticketPayload?: Record<string, unknown>,
): Promise<WebSocketLike> => {
  try {
    const ticket = await fetchWsTicket(ticketPayload)
    return new WebSocket(appendTicketToUrl(url, ticket)) as unknown as WebSocketLike
  } catch (error) {
    // Only fall back to unauthenticated connection for auth errors (user not logged in).
    // Other errors (network failures, 5xx) should propagate so the connection fails loudly.
    if (error instanceof HTTPError && (error.response.status === 401 || error.response.status === 403)) {
      return new WebSocket(url) as unknown as WebSocketLike
    }
    throw error
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
  ticketPayload,
  onStream,
  onDisconnected,
}: RemoteAgentConnectionOptions): { disconnect: () => void } => {
  const url = agentConfig.url
  if (!url) {
    throw new Error(`Agent "${agentConfig.name}" has no URL configured`)
  }

  const factory = createWebSocket ? () => createWebSocket(url) : () => ticketedWebSocketFactory(url, ticketPayload)

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
