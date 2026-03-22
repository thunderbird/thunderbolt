import type { Stream } from '@agentclientprotocol/sdk'
import type { AgentConfig } from './types'
import { createWebSocketStream, type WebSocketLike, WS_OPEN } from './websocket-stream'

type WebSocketFactory = (url: string) => WebSocketLike

type RemoteAgentConnectionOptions = {
  agentConfig: AgentConfig
  createWebSocket?: WebSocketFactory
}

type RemoteAgentConnection = {
  stream: Stream
  disconnect: () => void
}

const defaultWebSocketFactory: WebSocketFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike

/**
 * Connect to a remote ACP agent over WebSocket.
 * Returns the ACP stream and a disconnect function.
 */
export const connectToRemoteAgent = async ({
  agentConfig,
  createWebSocket = defaultWebSocketFactory,
}: RemoteAgentConnectionOptions): Promise<RemoteAgentConnection> => {
  const url = agentConfig.url
  if (!url) {
    throw new Error(`Agent "${agentConfig.name}" has no URL configured`)
  }

  const ws = createWebSocket(url)

  // Wait for connection to open
  await new Promise<void>((resolve, reject) => {
    if (ws.readyState === WS_OPEN) {
      resolve()
      return
    }

    const onOpen = () => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      resolve()
    }

    const onError = (_event: { data: string | ArrayBuffer }) => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      reject(new Error(`Failed to connect to agent "${agentConfig.name}" at ${url}`))
    }

    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
  })

  const stream = createWebSocketStream(ws)

  return {
    stream,
    disconnect: () => ws.close(),
  }
}
