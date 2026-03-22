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

export const WS_OPEN = 1
export const WS_CLOSED = 3

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
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (ws.readyState !== WS_OPEN) {
        throw new Error('WebSocket is not open')
      }
      const decoder = new TextDecoder()
      ws.send(decoder.decode(chunk))
    },
    close() {
      ws.close()
    },
  })

  return ndJsonStream(writable, readable)
}
