/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyMessage } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { getErrorRetryable } from '@/lib/error-utils'
import { TransportTerminationError } from '../termination'
import {
  authCloseCode,
  normalCloseCode,
  openWebSocketTransport,
  proxyRejectCloseCode,
  proxyForbiddenCloseCode,
  serverErrorCloseCode,
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
    this.listeners[type] = (this.listeners[type] as Listener<K>[]).filter(
      (candidate) => candidate !== listener,
    ) as never
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code: number = normalCloseCode): void {
    this.closed = { code }
    this.readyState = 3
    this.emit('close', { code, reason: '' })
  }

  emit<K extends keyof WebSocketEventMap>(type: K, event: WebSocketEventMap[K]): void {
    for (const listener of this.listeners[type]) {
      listener(event)
    }
  }

  open(): void {
    this.readyState = 1
    this.emit('open', { type: 'open' })
  }
}

const asWebSocketLike = (socket: FakeSocket): WebSocketLike => socket as unknown as WebSocketLike

const openSocket = async () => {
  const sockets: FakeSocket[] = []
  const transportPromise = openWebSocketTransport({
    url: 'wss://example.com/ws',
    signal: new AbortController().signal,
    webSocketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return asWebSocketLike(socket)
    },
    isTauriIos: () => false,
  })
  sockets[0].open()
  return { transport: await transportPromise, sockets }
}

describe('validateWebSocketUrl', () => {
  it('rejects cleartext sockets on Tauri iOS', () => {
    expect(() => validateWebSocketUrl('ws://example.com/ws', () => true)).toThrow(/Insecure WebSocket URL/)
    expect(() => validateWebSocketUrl('http://example.com/ws', () => true)).toThrow(/Insecure WebSocket URL/)
  })

  it('allows secure sockets on iOS and cleartext sockets elsewhere', () => {
    expect(() => validateWebSocketUrl('wss://example.com/ws', () => true)).not.toThrow()
    expect(() => validateWebSocketUrl('ws://example.com/ws', () => false)).not.toThrow()
  })
})

describe('openWebSocketTransport', () => {
  it('sends and receives JSON-RPC messages on the established socket', async () => {
    const { transport, sockets } = await openSocket()
    const writer = transport.stream.writable.getWriter()
    await writer.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as unknown as AnyMessage)
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ id: 1, method: 'initialize' })

    const reader = transport.stream.readable.getReader()
    sockets[0].emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
    await expect(reader.read()).resolves.toMatchObject({ value: { id: 1, result: {} }, done: false })
  })

  for (const code of [1006, normalCloseCode, proxyForbiddenCloseCode]) {
    it(`terminates the generation on remote close ${code} without reconnecting`, async () => {
      const { transport, sockets } = await openSocket()
      sockets[0].emit('close', { code, reason: 'dropped' })

      const error = await transport.closed?.catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(TransportTerminationError)
      expect(error).toMatchObject({ reason: 'remote-close' })
      expect(sockets).toHaveLength(1)

      const reader = transport.stream.readable.getReader()
      await expect(reader.read()).resolves.toMatchObject({ done: true })
    })
  }

  it('never queues or replays a write after the socket closes', async () => {
    const { transport, sockets } = await openSocket()
    sockets[0].emit('close', { code: 1006, reason: 'dropped' })
    const writer = transport.stream.writable.getWriter()

    await expect(
      writer.write({ jsonrpc: '2.0', id: 2, method: 'session/prompt' } as unknown as AnyMessage),
    ).rejects.toMatchObject({ reason: 'remote-close' })
    expect(sockets[0].sent).toEqual([])
    expect(sockets).toHaveLength(1)
  })

  it('resolves closed cleanly on caller close', async () => {
    const { transport, sockets } = await openSocket()
    transport.close()

    await expect(transport.closed).resolves.toBeUndefined()
    expect(sockets[0].closed).toEqual({ code: normalCloseCode })
  })

  it('classifies invalid inbound JSON as a stream error', async () => {
    const { transport, sockets } = await openSocket()
    sockets[0].emit('message', { data: '{invalid' })

    const error = await transport.closed?.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TransportTerminationError)
    expect(error).toMatchObject({ reason: 'stream-error' })
  })

  it('rejects a close that happens before the initial socket opens', async () => {
    const socket = new FakeSocket()
    const opening = openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: () => asWebSocketLike(socket),
      isTauriIos: () => false,
    })
    socket.emit('close', { code: 1006, reason: 'dropped' })

    await expect(opening).rejects.toMatchObject({ reason: 'remote-close' })
  })

  for (const code of [
    normalCloseCode,
    authCloseCode,
    proxyRejectCloseCode,
    proxyForbiddenCloseCode,
    serverErrorCloseCode,
  ]) {
    it(`marks deterministic connect close ${code} as non-retryable`, async () => {
      const socket = new FakeSocket()
      const opening = openWebSocketTransport({
        url: 'wss://example.com/ws',
        signal: new AbortController().signal,
        webSocketFactory: () => asWebSocketLike(socket),
        isTauriIos: () => false,
      })
      socket.emit('close', { code, reason: 'rejected' })

      const error = await opening.catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(TransportTerminationError)
      expect(getErrorRetryable(error as Error)).toBe(false)
      expect((error as TransportTerminationError).retryable).toBe(false)
    })

    it(`marks post-connect close ${code} as non-retryable`, async () => {
      const { transport, sockets } = await openSocket()
      sockets[0].emit('close', { code, reason: 'rejected' })

      const error = await transport.closed?.catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(TransportTerminationError)
      expect(error).toMatchObject({ reason: 'remote-close', retryable: false })
    })
  }

  it('keeps transient closes retryable in both phases', async () => {
    const socket = new FakeSocket()
    const opening = openWebSocketTransport({
      url: 'wss://example.com/ws',
      signal: new AbortController().signal,
      webSocketFactory: () => asWebSocketLike(socket),
      isTauriIos: () => false,
    })
    socket.emit('close', { code: 1006, reason: 'dropped' })

    const connectError = await opening.catch((reason: unknown) => reason)
    expect(connectError).toMatchObject({ reason: 'remote-close', retryable: true })
    expect(getErrorRetryable(connectError as Error)).toBeUndefined()

    const { transport, sockets } = await openSocket()
    sockets[0].emit('close', { code: 1006, reason: 'dropped' })
    const error = await transport.closed?.catch((reason: unknown) => reason)
    expect(error).toMatchObject({ reason: 'remote-close', retryable: true })
  })
})
