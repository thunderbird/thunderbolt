import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'

/**
 * Abstraction for WebSocket connections to allow testing.
 */
export type WebSocketLike = {
  send: (data: string | ArrayBuffer) => void
  close: () => void
  addEventListener: (event: string, handler: (event: { data: string | ArrayBuffer }) => void) => void
  removeEventListener: (event: string, handler: (event: { data: string | ArrayBuffer }) => void) => void
  readyState: number
}

export const wsOpen = 1
export const wsClosed = 3

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

type ReconnectOptions = {
  /** Called with each newly opened WebSocket on connect and reconnect. */
  onConnect: (ws: WebSocketLike) => void
  /** Called after all retries are exhausted. */
  onGiveUp: () => void
  createWebSocket: () => WebSocketLike
}

/**
 * Manage a WebSocket connection with exponential backoff reconnection.
 * Calls onConnect with each new WebSocket upon a successful open.
 * Retries up to MAX_RETRIES (3) times on unexpected close, doubling the delay
 * each attempt starting from BASE_DELAY_MS (1000ms).
 * Does not reconnect on normal close (code 1000).
 */
export const connectWithReconnect = ({ onConnect, onGiveUp, createWebSocket }: ReconnectOptions): void => {
  let retries = 0

  const attempt = () => {
    const ws = createWebSocket()

    ws.addEventListener('open', (_event) => {
      retries = 0
      onConnect(ws)
    })

    ws.addEventListener('close', (event) => {
      if ((event as { code?: number }).code === 1000) {
        return
      }
      if (retries >= MAX_RETRIES) {
        onGiveUp()
        return
      }
      const delay = BASE_DELAY_MS * Math.pow(2, retries)
      retries++
      setTimeout(attempt, delay)
    })
  }

  attempt()
}

/**
 * Create an ACP Stream from a WebSocket connection.
 * The remote server must speak ACP (newline-delimited JSON-RPC).
 */
export const createWebSocketStream = (ws: WebSocketLike): Stream => {
  // WebSocket → ReadableStream (incoming messages)
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()

      const onMessage = (event: { data: string | ArrayBuffer }) => {
        const data = typeof event.data === 'string' ? encoder.encode(event.data + '\n') : new Uint8Array(event.data)
        controller.enqueue(data)
      }

      const onClose = () => {
        try {
          controller.close()
        } catch {
          // Already closed
        }
      }

      const onError = () => {
        try {
          controller.error(new Error('WebSocket error'))
        } catch {
          // Already closed
        }
      }

      ws.addEventListener('message', onMessage)
      ws.addEventListener('close', onClose)
      ws.addEventListener('error', onError)
    },
  })

  // WritableStream → WebSocket (outgoing messages)
  const decoder = new TextDecoder()
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (ws.readyState !== wsOpen) {
        throw new Error('WebSocket is not open')
      }
      ws.send(decoder.decode(chunk))
    },
    close() {
      ws.close()
    },
  })

  return ndJsonStream(writable, readable)
}
