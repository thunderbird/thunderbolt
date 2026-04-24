import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'

type WebSocketMessageEvent = { data: string | ArrayBuffer }
type WebSocketCloseEvent = { code?: number; reason?: string }

type WebSocketEventMap = {
  open: Event | Record<string, never>
  message: WebSocketMessageEvent
  close: WebSocketCloseEvent
  error: Event | Record<string, never>
}

/**
 * Abstraction for WebSocket connections to allow testing.
 */
export type WebSocketLike = {
  send: (data: string | ArrayBuffer) => void
  close: () => void
  addEventListener: <K extends keyof WebSocketEventMap>(
    event: K,
    handler: (event: WebSocketEventMap[K]) => void,
  ) => void
  removeEventListener: <K extends keyof WebSocketEventMap>(
    event: K,
    handler: (event: WebSocketEventMap[K]) => void,
  ) => void
  readyState: number
}

export const wsOpen = 1
export const wsClosed = 3

const maxRetries = 3
const baseDelayMs = 1000

type ReconnectOptions = {
  /** Called with each newly opened WebSocket on connect and reconnect. */
  onConnect: (ws: WebSocketLike) => void
  /** Called after all retries are exhausted. */
  onGiveUp: () => void
  createWebSocket: () => WebSocketLike | Promise<WebSocketLike>
}

/**
 * Manage a WebSocket connection with exponential backoff reconnection.
 * Calls onConnect with each new WebSocket upon a successful open.
 * Retries up to maxRetries (3) times on unexpected close, doubling the delay
 * each attempt starting from baseDelayMs (1000ms).
 * Does not reconnect on normal close (code 1000).
 * Returns a cancel function to abort any pending retry timeout.
 */
export const connectWithReconnect = ({
  onConnect,
  onGiveUp,
  createWebSocket,
}: ReconnectOptions): { cancel: () => void } => {
  let retries = 0
  let retryTimeout: ReturnType<typeof setTimeout> | undefined

  const wireSocket = (ws: WebSocketLike) => {
    ws.addEventListener('open', (_event) => {
      retries = 0
      onConnect(ws)
    })

    ws.addEventListener('close', (event) => {
      const code = event.code
      if (code === 1000 || code === 4001) {
        return
      }
      if (retries >= maxRetries) {
        onGiveUp()
        return
      }
      const delay = baseDelayMs * Math.pow(2, retries)
      retries++
      retryTimeout = setTimeout(attempt, delay)
    })
  }

  const attempt = () => {
    const result = createWebSocket()

    // Support both sync and async createWebSocket
    if (result instanceof Promise) {
      void (async () => {
        try {
          wireSocket(await result)
        } catch {
          if (retries >= maxRetries) {
            onGiveUp()
            return
          }
          const delay = baseDelayMs * Math.pow(2, retries)
          retries++
          retryTimeout = setTimeout(attempt, delay)
        }
      })()
    } else {
      wireSocket(result)
    }
  }

  attempt()

  return {
    cancel: () => {
      if (retryTimeout) {
        clearTimeout(retryTimeout)
      }
    },
  }
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
