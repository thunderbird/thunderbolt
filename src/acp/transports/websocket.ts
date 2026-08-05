/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One-shot WebSocket transport for ACP. A dropped socket terminates the whole
 * ACP generation; reconnecting is owned by the adapter slot so a fresh socket,
 * `ClientSideConnection`, `initialize`, and session attachment are rebuilt
 * together. ACP messages are framed one JSON-RPC object per WebSocket message.
 */

import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { getPlatform } from '@/lib/platform'
import { TransportTerminationError } from '../termination'
import type { AcpTransport } from '../types'

export const normalCloseCode = 1000
export const authCloseCode = 4001
export const proxyRejectCloseCode = 4002
export const proxyForbiddenCloseCode = 4003
export const serverErrorCloseCode = 1011

/** Close codes that mean "do not bother reconnecting", governing both phases:
 *  a clean close, an auth rejection, the proxy's two hard rejects, and a
 *  server-internal error. A remote 1000 is the bridge deliberately shutting
 *  down — the CLI spawns one subprocess per accepted connection, so
 *  auto-reconnecting would resurrect a doomed subprocess on a dead endpoint. */
const terminalCloseCodes = new Set([
  normalCloseCode,
  authCloseCode,
  proxyRejectCloseCode,
  proxyForbiddenCloseCode,
  serverErrorCloseCode,
])

/** Classify deterministic connect rejections so chat skips futile auto-retries. */
const connectCloseError = (code: number): TransportTerminationError => {
  const detail = `ACP transport closed during connect (code ${code})`
  const retryable = !terminalCloseCodes.has(code)
  // Connect rejections cross into the chat layer as a bare message string, so
  // the retry verdict also travels as JSON inside it (see `getErrorRetryable`)
  // — the typed field is for lifecycle code that sees the error object itself.
  const message = retryable ? detail : JSON.stringify({ error: detail, isRetryable: false })
  return new TransportTerminationError('remote-close', message, { retryable })
}

/** Subset of the native `WebSocket` interface used by the transport. */
export type WebSocketLike = {
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  addEventListener: {
    (type: 'open', listener: (event: WebSocketEventMap['open']) => void): void
    (type: 'message', listener: (event: WebSocketEventMap['message']) => void): void
    (type: 'close', listener: (event: WebSocketEventMap['close']) => void): void
    (type: 'error', listener: (event: WebSocketEventMap['error']) => void): void
  }
  removeEventListener: {
    (type: 'open', listener: (event: WebSocketEventMap['open']) => void): void
    (type: 'message', listener: (event: WebSocketEventMap['message']) => void): void
    (type: 'close', listener: (event: WebSocketEventMap['close']) => void): void
    (type: 'error', listener: (event: WebSocketEventMap['error']) => void): void
  }
}

export type WebSocketEventMap = {
  open: { type: 'open' }
  message: { data: string }
  close: { code: number; reason: string }
  error: { message?: string }
}

export type WebSocketFactory = (url: string) => WebSocketLike
export type IsTauriIosFn = () => boolean

const defaultWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike

const defaultIsTauriIos: IsTauriIosFn = () => {
  if (typeof window === 'undefined' || !('isTauri' in window)) {
    return false
  }
  return getPlatform() === 'ios'
}

/** Reject cleartext WebSockets on Tauri iOS, where ATS blocks them. */
export const validateWebSocketUrl = (url: string, isTauriIos: IsTauriIosFn = defaultIsTauriIos): void => {
  if (!isTauriIos()) {
    return
  }
  const lower = url.toLowerCase()
  if (lower.startsWith('ws://') || lower.startsWith('http://')) {
    throw new Error(`Insecure WebSocket URL not allowed on iOS: ${url}. Use wss:// instead.`)
  }
}

export type WebSocketTransportOptions = {
  url: string
  signal: AbortSignal
  webSocketFactory?: WebSocketFactory
  isTauriIos?: IsTauriIosFn
}

/** Open one WebSocket-backed ACP generation. */
export const openWebSocketTransport = async (options: WebSocketTransportOptions): Promise<AcpTransport> => {
  validateWebSocketUrl(options.url, options.isTauriIos)

  const socket = (options.webSocketFactory ?? defaultWebSocketFactory)(options.url)
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      options.signal.removeEventListener('abort', onAbort)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onError = (event: WebSocketEventMap['error']): void => {
      cleanup()
      reject(new Error(event.message ?? 'WebSocket error'))
    }
    const onClose = (event: WebSocketEventMap['close']): void => {
      cleanup()
      reject(connectCloseError(event.code))
    }
    const onAbort = (): void => {
      cleanup()
      socket.close(normalCloseCode)
      reject(new DOMException('aborted', 'AbortError'))
    }

    if (options.signal.aborted) {
      onAbort()
      return
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
    options.signal.addEventListener('abort', onAbort, { once: true })
  })

  let settleClosed: ((reason: TransportTerminationError | null) => void) | null = null
  const closed = new Promise<void>((resolve, reject) => {
    settleClosed = (reason) => (reason ? reject(reason) : resolve())
  })
  closed.catch(() => {})

  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null
  let readableClosed = false
  let locallyClosed = false

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller
    },
  })

  const settleClosedOnce = (reason: TransportTerminationError | null): void => {
    if (!settleClosed) {
      return
    }
    const settle = settleClosed
    settleClosed = null
    settle(reason)
  }

  const closeReadable = (): void => {
    if (readableClosed) {
      return
    }
    readableClosed = true
    readableController?.close()
  }

  const detachLifecycle = (): void => {
    socket.removeEventListener('message', onMessage)
    socket.removeEventListener('close', onClose)
    options.signal.removeEventListener('abort', close)
  }

  const terminate = (error: TransportTerminationError): void => {
    if (!settleClosed) {
      return
    }
    detachLifecycle()
    closeReadable()
    settleClosedOnce(error)
  }

  const onMessage = (event: WebSocketEventMap['message']): void => {
    if (readableClosed) {
      return
    }
    try {
      readableController?.enqueue(JSON.parse(event.data) as AnyMessage)
    } catch (cause) {
      const error = new TransportTerminationError('stream-error', 'ACP WebSocket received invalid JSON', { cause })
      terminate(error)
      socket.close(normalCloseCode)
    }
  }

  const onClose = (event: WebSocketEventMap['close']): void => {
    if (locallyClosed) {
      return
    }
    terminate(
      new TransportTerminationError('remote-close', `ACP transport closed (code ${event.code})`, {
        retryable: !terminalCloseCodes.has(event.code),
      }),
    )
  }

  const close = (): void => {
    if (locallyClosed) {
      return
    }
    locallyClosed = true
    detachLifecycle()
    closeReadable()
    settleClosedOnce(null)
    socket.close(normalCloseCode)
  }

  socket.addEventListener('message', onMessage)
  socket.addEventListener('close', onClose)
  options.signal.addEventListener('abort', close, { once: true })

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      if (readableClosed || socket.readyState !== 1) {
        throw new TransportTerminationError('remote-close', 'ACP transport is closed')
      }
      socket.send(JSON.stringify(message))
    },
    close,
    abort: close,
  })

  const stream: Stream = { readable, writable }
  return { stream, close, closed }
}
