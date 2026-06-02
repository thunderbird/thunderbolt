/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WebSocket transport tests. Uses a `FakeSocket` that emits events on demand
 * — no `mock.module()`, no real network. The platform detector and backoff
 * are injected via DI so the test runs in jsdom.
 */

import '@/testing-library'

import { act } from '@testing-library/react'
import type { AnyMessage } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import {
  authCloseCode,
  normalCloseCode,
  proxyRejectCloseCode,
  proxyForbiddenCloseCode,
  serverErrorCloseCode,
  isReconnectableCloseCode,
  openWebSocketTransport,
  validateWebSocketUrl,
  type WebSocketEventMap,
  type WebSocketLike,
} from './websocket'

type Listener<K extends keyof WebSocketEventMap> = (event: WebSocketEventMap[K]) => void

class FakeSocket {
  readyState = 0
  private listeners: { [K in keyof WebSocketEventMap]: Listener<K>[] } = {
    open: [],
    message: [],
    close: [],
    error: [],
  }
  sent: string[] = []
  closed: { code: number } | null = null

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: Listener<K>): void {
    this.listeners[type].push(listener as never)
  }
  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: Listener<K>): void {
    this.listeners[type] = (this.listeners[type] as Listener<K>[]).filter((l) => l !== listener) as never
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(code: number = normalCloseCode): void {
    this.closed = { code }
    this.readyState = 3
    // Mimic browser close-event behaviour.
    this.emit('close', { code, reason: '' })
  }
  emit<K extends keyof WebSocketEventMap>(type: K, event: WebSocketEventMap[K]): void {
    for (const l of this.listeners[type]) {
      l(event)
    }
  }
  open(): void {
    this.readyState = 1
    this.emit('open', { type: 'open' })
  }
  failOpen(message = 'connect failed'): void {
    this.emit('error', { message })
  }
}

const asWebSocketLike = (s: FakeSocket): WebSocketLike => s as unknown as WebSocketLike

const drainReadable = async (readable: ReadableStream<AnyMessage>, max: number): Promise<AnyMessage[]> => {
  const out: AnyMessage[] = []
  const reader = readable.getReader()
  for (let i = 0; i < max; i++) {
    const { value, done } = await reader.read()
    if (done || !value) {
      break
    }
    out.push(value)
  }
  reader.releaseLock()
  return out
}

describe('validateWebSocketUrl', () => {
  it('rejects ws:// on Tauri iOS', () => {
    expect(() => validateWebSocketUrl('ws://example.com/ws', () => true)).toThrow(/Insecure WebSocket URL/)
  })
  it('rejects http:// on Tauri iOS', () => {
    expect(() => validateWebSocketUrl('http://example.com/ws', () => true)).toThrow(/Insecure WebSocket URL/)
  })
  it('allows wss:// on Tauri iOS', () => {
    expect(() => validateWebSocketUrl('wss://example.com/ws', () => true)).not.toThrow()
  })
  it('allows ws:// off-iOS', () => {
    expect(() => validateWebSocketUrl('ws://example.com/ws', () => false)).not.toThrow()
  })
})

describe('isReconnectableCloseCode', () => {
  it('is terminal for clean/auth/proxy-reject/server-error codes', () => {
    expect(isReconnectableCloseCode(normalCloseCode)).toBe(false)
    expect(isReconnectableCloseCode(authCloseCode)).toBe(false)
    expect(isReconnectableCloseCode(proxyRejectCloseCode)).toBe(false)
    expect(isReconnectableCloseCode(proxyForbiddenCloseCode)).toBe(false)
    expect(isReconnectableCloseCode(serverErrorCloseCode)).toBe(false)
    // Spelled-out codes to lock the contract from the task.
    expect(isReconnectableCloseCode(4001)).toBe(false)
    expect(isReconnectableCloseCode(4002)).toBe(false)
    expect(isReconnectableCloseCode(4003)).toBe(false)
    expect(isReconnectableCloseCode(1011)).toBe(false)
  })
  it('reconnects on genuinely transient codes (1006, 1012, 1013)', () => {
    expect(isReconnectableCloseCode(1006)).toBe(true)
    expect(isReconnectableCloseCode(1012)).toBe(true)
    expect(isReconnectableCloseCode(1013)).toBe(true)
  })
})

describe('openWebSocketTransport — connect / send / receive', () => {
  it('opens, sends queued messages after open, and parses inbound JSON to AnyMessage', async () => {
    const socket = new FakeSocket()
    const factoryCalls: string[] = []
    const factory = (url: string): WebSocketLike => {
      factoryCalls.push(url)
      return asWebSocketLike(socket)
    }

    const transportPromise = openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 1,
    })
    // Allow microtask: socket.open() fires synchronously.
    socket.open()
    const transport = await transportPromise

    // Write goes through immediately because readyState=1
    const writer = transport.stream.writable.getWriter()
    await writer.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as unknown as AnyMessage)
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0])).toMatchObject({ id: 1, method: 'initialize' })
    writer.releaseLock()

    // Inbound message
    socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
    const inbound = await drainReadable(transport.stream.readable, 1)
    expect(inbound[0]).toMatchObject({ id: 1, result: {} })

    expect(factoryCalls).toEqual(['wss://example.com/ws'])
  })
})

describe('openWebSocketTransport — reconnect', () => {
  it('reconnects on unexpected close and reuses the same readable stream', async () => {
    const sockets: FakeSocket[] = []
    const factory = (): WebSocketLike => {
      const s = new FakeSocket()
      sockets.push(s)
      // Open the next tick so retries can be observed.
      queueMicrotask(() => s.open())
      return asWebSocketLike(s)
    }
    const transport = await openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 1,
    })

    // Drop with a reconnectable code.
    sockets[0].emit('close', { code: 1006, reason: 'network blip' })
    // Tick to let the backoff sleep resolve and reconnect run.
    await act(async () => {
      await getClock().tickAsync(2)
      await getClock().runAllAsync()
    })

    expect(sockets.length).toBeGreaterThanOrEqual(2)
    // The new socket carries messages on the same readable.
    sockets[sockets.length - 1].emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }),
    })
    const inbound = await drainReadable(transport.stream.readable, 1)
    expect(inbound[0]).toMatchObject({ method: 'session/update' })
  })

  it('gives up after maxReconnectAttempts failed connects and closes the readable', async () => {
    const sockets: FakeSocket[] = []
    const factory = (): WebSocketLike => {
      const s = new FakeSocket()
      sockets.push(s)
      // First socket opens successfully; all reconnects fail to open.
      queueMicrotask(() => {
        if (sockets.length === 1) {
          s.open()
        } else {
          s.failOpen('boom')
        }
      })
      return asWebSocketLike(s)
    }
    const transport = await openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 1,
      maxReconnectAttempts: 3,
    })

    // Trigger reconnect path with a transient close.
    sockets[0].emit('close', { code: 1006, reason: 'transient' })
    await act(async () => {
      await getClock().runAllAsync()
    })

    // After the budget, the transport should have given up and closed the
    // readable. Verify by draining to done.
    const reader = transport.stream.readable.getReader()
    const result = await Promise.race([
      reader.read(),
      new Promise<{ value: AnyMessage | undefined; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: false }), 100),
      ),
    ])
    expect(result.done).toBe(true)
    // First socket + 4 attempts (initial + 3 retries) of reconnect = 5 sockets.
    expect(sockets.length).toBeGreaterThanOrEqual(4)
  })

  it('AbortController on the adapter cancels pending reconnect sleep', async () => {
    const controller = new AbortController()
    const sockets: FakeSocket[] = []
    // First socket opens; subsequent connect attempts hang until aborted so
    // we can verify the abort path closes the readable instead of looping.
    const factory = (): WebSocketLike => {
      const s = new FakeSocket()
      sockets.push(s)
      if (sockets.length === 1) {
        queueMicrotask(() => s.open())
      }
      return asWebSocketLike(s)
    }
    const transport = await openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: controller.signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 10_000,
    })

    // Drop with reconnectable code so reconnect enters connectOnce on a socket
    // that never opens (and never errors).
    sockets[0].emit('close', { code: 1006, reason: 'transient' })
    controller.abort()
    await act(async () => {
      await getClock().runAllAsync()
    })

    // The readable must terminate (drain to done) within a tick after abort.
    const reader = transport.stream.readable.getReader()
    const result = await Promise.race([
      reader.read(),
      new Promise<{ value: AnyMessage | undefined; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: false }), 50),
      ),
    ])
    expect(result.done).toBe(true)
  })

  it('does not reconnect on normal close (1000)', async () => {
    const sockets: FakeSocket[] = []
    const factory = (): WebSocketLike => {
      const s = new FakeSocket()
      sockets.push(s)
      queueMicrotask(() => s.open())
      return asWebSocketLike(s)
    }
    const transport = await openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 1,
    })

    sockets[0].emit('close', { code: normalCloseCode, reason: 'clean' })
    await act(async () => {
      await getClock().tickAsync(10)
    })
    expect(sockets.length).toBe(1)
    transport.close()
  })

  it('does not reconnect on auth close (4001)', async () => {
    const sockets: FakeSocket[] = []
    const factory = (): WebSocketLike => {
      const s = new FakeSocket()
      sockets.push(s)
      queueMicrotask(() => s.open())
      return asWebSocketLike(s)
    }
    const transport = await openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 1,
    })

    sockets[0].emit('close', { code: authCloseCode, reason: 'auth' })
    await act(async () => {
      await getClock().tickAsync(10)
    })
    expect(sockets.length).toBe(1)
    transport.close()
  })
})

describe('openWebSocketTransport — terminal-close signal (closed promise)', () => {
  const openSingleSocket = async () => {
    const sockets: FakeSocket[] = []
    const factory = (): WebSocketLike => {
      const s = new FakeSocket()
      sockets.push(s)
      queueMicrotask(() => s.open())
      return asWebSocketLike(s)
    }
    const transport = await openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 1,
      maxReconnectAttempts: 3,
    })
    return { transport, sockets }
  }

  /** Settle a `closed` promise to a tagged result so a test can assert on it
   *  without `.rejects` hanging when the promise never settles. */
  const observeClosed = (closed: Promise<void> | undefined): Promise<{ rejected: boolean; message?: string }> => {
    if (!closed) {
      throw new Error('transport.closed missing')
    }
    return closed.then(
      () => ({ rejected: false }),
      (err: Error) => ({ rejected: true, message: err.message }),
    )
  }

  it('rejects `closed` on a terminal close code (4003) and does not reconnect', async () => {
    const { transport, sockets } = await openSingleSocket()
    const observed = observeClosed(transport.closed)

    sockets[0].emit('close', { code: proxyForbiddenCloseCode, reason: 'forbidden' })
    await act(async () => {
      await getClock().tickAsync(10)
    })

    const result = await observed
    expect(result.rejected).toBe(true)
    expect(result.message).toMatch(/code 4003/)
    expect(sockets.length).toBe(1)
  })

  it('rejects `closed` when reconnect attempts are exhausted', async () => {
    const sockets: FakeSocket[] = []
    const factory = (): WebSocketLike => {
      const s = new FakeSocket()
      sockets.push(s)
      queueMicrotask(() => {
        if (sockets.length === 1) {
          s.open()
        } else {
          s.failOpen('boom')
        }
      })
      return asWebSocketLike(s)
    }
    const transport = await openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: factory,
      isTauriIos: () => false,
      backoffMs: () => 1,
      maxReconnectAttempts: 3,
    })
    const observed = observeClosed(transport.closed)

    sockets[0].emit('close', { code: 1006, reason: 'transient' })
    await act(async () => {
      await getClock().runAllAsync()
    })

    const result = await observed
    expect(result.rejected).toBe(true)
    expect(result.message).toMatch(/reconnect attempts exhausted/)
  })

  it('resolves `closed` (no rejection) on caller-initiated close()', async () => {
    const { transport } = await openSingleSocket()
    transport.close()
    const result = await observeClosed(transport.closed)
    expect(result.rejected).toBe(false)
  })
})
