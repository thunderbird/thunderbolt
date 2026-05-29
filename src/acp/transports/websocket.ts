/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WebSocket transport for ACP. Wraps a `WebSocket` (native in Tauri Standalone,
 * subprotocol-tunnelled via `createProxyWebSocket` in Connected) and adapts it
 * to the ACP SDK's `Stream` type (a pair of newline-delimited JSON streams).
 *
 * Reconnect strategy:
 *   - Up to 3 retries with exponential backoff (1s, 2s, 4s).
 *   - Don't reconnect on normal close (code 1000) or auth close (code 4001).
 *   - All retries respect the caller's `AbortController` — `disconnect()` aborts
 *     pending retries and resolves any in-flight wait immediately.
 *
 * ACP messages are JSON-RPC objects framed one-per-WS-message. No newline
 * framing is needed for WS — each `onmessage` is already a discrete payload.
 */

import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { getPlatform } from '@/lib/platform'
import type { AcpTransport } from '../types'

export const normalCloseCode = 1000
export const authCloseCode = 4001
export const maxReconnectAttempts = 3

/** Subset of the native `WebSocket` interface used by the transport. Lets us
 *  inject a fake socket in tests without `mock.module()`. Events are typed
 *  per-listener via overloads so each handler sees the correct payload shape. */
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

const defaultBackoffMs = (attempt: number): number => 1000 * Math.pow(2, attempt - 1)

const defaultWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike

const defaultIsTauriIos: IsTauriIosFn = () => {
  if (typeof window === 'undefined' || !('isTauri' in window)) {
    return false
  }
  return getPlatform() === 'ios'
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** Reject `ws://` / `http://` URLs on Tauri iOS. ATS blocks cleartext sockets;
 *  the validator surfaces a clear error before the OS would silently fail. */
export const validateWebSocketUrl = (url: string, isTauriIos: IsTauriIosFn = defaultIsTauriIos): void => {
  if (!isTauriIos()) {
    return
  }
  const lower = url.toLowerCase()
  if (lower.startsWith('ws://') || lower.startsWith('http://')) {
    throw new Error(`Insecure WebSocket URL not allowed on iOS: ${url}. Use wss:// instead.`)
  }
}

export const isReconnectableCloseCode = (code: number): boolean => code !== normalCloseCode && code !== authCloseCode

export type WebSocketTransportOptions = {
  url: string
  signal: AbortSignal
  webSocketFactory?: WebSocketFactory
  isTauriIos?: IsTauriIosFn
  /** Override backoff for tests so reconnects don't block the test runner. */
  backoffMs?: (attempt: number) => number
  maxReconnectAttempts?: number
}

/** Open a WebSocket transport against `url`, automatically reconnecting on
 *  unexpected closes up to `maxReconnectAttempts`. The returned `AcpTransport`
 *  exposes a `Stream` of ACP messages plus a `close()` hook that aborts the
 *  internal controller (cancels pending retries) and closes the socket. */
export const openWebSocketTransport = async (options: WebSocketTransportOptions): Promise<AcpTransport> => {
  validateWebSocketUrl(options.url, options.isTauriIos)

  const factory = options.webSocketFactory ?? defaultWebSocketFactory
  const backoff = options.backoffMs ?? defaultBackoffMs
  const maxAttempts = options.maxReconnectAttempts ?? maxReconnectAttempts

  // Inner abort controller — composed with caller's signal. Aborts when either
  // the caller cancels OR retries exhaust OR a terminal close code arrives.
  const transportController = new AbortController()
  if (options.signal.aborted) {
    transportController.abort()
  } else {
    options.signal.addEventListener('abort', () => transportController.abort(), { once: true })
  }

  let currentSocket: WebSocketLike | null = null
  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null
  let readableClosed = false
  const writeQueue: AnyMessage[] = []

  const closeReadable = (): void => {
    if (readableClosed) {
      return
    }
    readableClosed = true
    readableController?.close()
  }

  const drainWriteQueue = (): void => {
    if (!currentSocket || currentSocket.readyState !== 1) {
      return
    }
    while (writeQueue.length > 0) {
      const msg = writeQueue.shift()!
      currentSocket.send(JSON.stringify(msg))
    }
  }

  const enqueueOutbound = (msg: AnyMessage): void => {
    if (currentSocket && currentSocket.readyState === 1) {
      currentSocket.send(JSON.stringify(msg))
      return
    }
    writeQueue.push(msg)
  }

  const connectOnce = (): Promise<WebSocketLike> =>
    new Promise((resolve, reject) => {
      const socket = factory(options.url)
      const cleanup = (): void => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        transportController.signal.removeEventListener('abort', onAbort)
      }
      const onOpen = (): void => {
        cleanup()
        resolve(socket)
      }
      const onError = (event: WebSocketEventMap['error']): void => {
        cleanup()
        reject(new Error(event.message ?? 'WebSocket error'))
      }
      const onAbort = (): void => {
        cleanup()
        socket.close(normalCloseCode)
        reject(new DOMException('aborted', 'AbortError'))
      }
      if (transportController.signal.aborted) {
        socket.close(normalCloseCode)
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      transportController.signal.addEventListener('abort', onAbort, { once: true })
    })

  const connectWithRetry = async (): Promise<WebSocketLike> => {
    let attempt = 0
    let lastError: Error | null = null
    while (attempt <= maxAttempts) {
      if (transportController.signal.aborted) {
        throw new DOMException('aborted', 'AbortError')
      }
      try {
        const socket = await connectOnce()
        return socket
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        attempt++
        if (attempt > maxAttempts) {
          break
        }
        await sleep(backoff(attempt), transportController.signal)
      }
    }
    throw lastError ?? new Error('WebSocket connect failed')
  }

  const handleClose = (code: number): void => {
    if (transportController.signal.aborted || !isReconnectableCloseCode(code)) {
      closeReadable()
      transportController.abort()
      return
    }
    connectWithRetry()
      .then((socket) => {
        currentSocket = socket
        attachLifecycle(socket)
        drainWriteQueue()
      })
      .catch(() => {
        readableController?.close()
        transportController.abort()
      })
  }

  const attachLifecycle = (socket: WebSocketLike): void => {
    const onMessage = (event: WebSocketEventMap['message']): void => {
      if (!readableController || readableClosed) {
        return
      }
      const parsed = JSON.parse(event.data) as AnyMessage
      readableController.enqueue(parsed)
    }
    const onClose = (event: WebSocketEventMap['close']): void => {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      handleClose(event.code)
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
  }

  // First connect resolves synchronously so the caller knows whether the
  // handshake is alive before sending `initialize`.
  currentSocket = await connectWithRetry()

  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      readableController = c
    },
  })

  attachLifecycle(currentSocket)
  drainWriteQueue()

  const writable = new WritableStream<AnyMessage>({
    write(msg) {
      enqueueOutbound(msg)
    },
    close() {
      currentSocket?.close(normalCloseCode)
    },
    abort() {
      currentSocket?.close(normalCloseCode)
    },
  })

  const stream: Stream = { readable, writable }

  const close = (): void => {
    transportController.abort()
    currentSocket?.close(normalCloseCode)
    closeReadable()
  }

  transportController.signal.addEventListener(
    'abort',
    () => {
      currentSocket?.close(normalCloseCode)
    },
    { once: true },
  )

  return { stream, close }
}
