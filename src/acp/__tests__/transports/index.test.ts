/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transport factory dispatch tests. Verifies the agent-type routing:
 *   - `managed-acp` always uses a native WebSocket (no `tbproxy.target.`
 *     subprotocol), regardless of platform.
 *   - `remote-acp` on Web routes through the universal proxy
 *     (subprotocol-tunnelled).
 *   - `remote-acp` on Tauri Standalone uses a native WebSocket.
 *
 * The proxy-vs-native decision is inspected at the layer below `openTransport`
 * — we install a fake global `WebSocket` constructor and read what
 * `new WebSocket(url, protocols)` is called with. No `mock.module()` is
 * required (DI for `isStandalone` / `readProxyEnabled`).
 */

import '@/testing-library'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { wsTargetPrefix } from '@shared/proxy-protocol'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { openTransport } from '../../transports'
import { type WebSocketEventMap } from '../../transports/websocket'

type Listener<K extends keyof WebSocketEventMap> = (event: WebSocketEventMap[K]) => void

class FakeBrowserSocket {
  static instances: FakeBrowserSocket[] = []
  static reset(): void {
    FakeBrowserSocket.instances = []
  }
  url: string
  protocols: string[]
  readyState = 0
  private listeners: { [K in keyof WebSocketEventMap]: Listener<K>[] } = {
    open: [],
    message: [],
    close: [],
    error: [],
  }
  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = typeof protocols === 'string' ? [protocols] : (protocols ?? [])
    FakeBrowserSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      for (const l of this.listeners.open) {
        l({ type: 'open' })
      }
    })
  }
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: Listener<K>): void {
    this.listeners[type].push(listener as never)
  }
  removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: Listener<K>): void {
    this.listeners[type] = (this.listeners[type] as Listener<K>[]).filter((l) => l !== listener) as never
  }
  send(_data: string): void {}
  close(_code?: number, _reason?: string): void {
    this.readyState = 3
  }
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  FakeBrowserSocket.reset()
  // Cast through unknown — FakeBrowserSocket only implements the surface the
  // transport uses, not the full DOM `WebSocket` interface.
  globalThis.WebSocket = FakeBrowserSocket as unknown as typeof WebSocket
  useLocalSettingsStore.setState({ cloudUrl: 'http://cloud.test/v1' })
})

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
})

// A minimal HttpClient stub — `openTransport` only ever reaches into it
// indirectly via `fetchTicket`, so the methods can be no-ops cast through unknown.
const stubHttpClient = {
  get: () => Promise.resolve(new Response()),
  post: () => Promise.resolve(new Response()),
  delete: () => Promise.resolve(new Response()),
} as unknown as Parameters<typeof openTransport>[0]['httpClient']

describe('openTransport — agent-type routing', () => {
  it('managed-acp on Web fetches a ticket and offers thunderbolt.v1 + thunderbolt.ticket.<nonce>', async () => {
    const transport = await openTransport({
      url: 'wss://cloud.test/v1/haystack/ws?pipeline=p1',
      transport: 'websocket',
      agentType: 'managed-acp',
      signal: new AbortController().signal,
      isStandalone: () => false,
      readProxyEnabled: () => null,
      backoffMs: () => 1,
      httpClient: stubHttpClient,
      fetchTicket: () => Promise.resolve('test-nonce-123'),
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.url).toBe('wss://cloud.test/v1/haystack/ws?pipeline=p1')
    expect(socket.protocols).toContain('thunderbolt.v1')
    expect(socket.protocols).toContain('thunderbolt.ticket.test-nonce-123')
    expect(socket.protocols.some((p) => p.startsWith(wsTargetPrefix))).toBe(false)

    transport.close()
  })

  it('managed-acp on Tauri Standalone connects direct (no ticket, no proxy)', async () => {
    let fetched = false
    const transport = await openTransport({
      url: 'wss://cloud.test/v1/haystack/ws?pipeline=p1',
      transport: 'websocket',
      agentType: 'managed-acp',
      signal: new AbortController().signal,
      isStandalone: () => true,
      readProxyEnabled: () => 'false',
      backoffMs: () => 1,
      httpClient: stubHttpClient,
      fetchTicket: () => {
        fetched = true
        return Promise.resolve('should-not-be-used')
      },
    })

    expect(fetched).toBe(false)
    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.url).toBe('wss://cloud.test/v1/haystack/ws?pipeline=p1')
    expect(socket.protocols).toHaveLength(0)
    expect(socket.protocols.some((p) => p.startsWith(wsTargetPrefix))).toBe(false)

    transport.close()
  })

  it('managed-acp with no httpClient falls back to a direct connect (graceful)', async () => {
    const transport = await openTransport({
      url: 'wss://cloud.test/v1/haystack/ws?pipeline=p1',
      transport: 'websocket',
      agentType: 'managed-acp',
      signal: new AbortController().signal,
      isStandalone: () => false,
      readProxyEnabled: () => null,
      backoffMs: () => 1,
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.protocols).toHaveLength(0)

    transport.close()
  })

  it('remote-acp on Web routes through the universal proxy (subprotocol tunnel)', async () => {
    const transport = await openTransport({
      url: 'wss://agent.example.com/acp',
      transport: 'websocket',
      agentType: 'remote-acp',
      signal: new AbortController().signal,
      isStandalone: () => false,
      readProxyEnabled: () => null,
      backoffMs: () => 1,
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.url).toBe('ws://cloud.test/v1/proxy/ws')
    const target = socket.protocols.find((p) => p.startsWith(wsTargetPrefix))
    expect(target).toBeDefined()

    transport.close()
  })

  it('remote-acp on Tauri Standalone uses a native WebSocket (no proxy)', async () => {
    const transport = await openTransport({
      url: 'wss://agent.example.com/acp',
      transport: 'websocket',
      agentType: 'remote-acp',
      signal: new AbortController().signal,
      isStandalone: () => true,
      readProxyEnabled: () => null,
      backoffMs: () => 1,
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.url).toBe('wss://agent.example.com/acp')
    expect(socket.protocols.some((p) => p.startsWith(wsTargetPrefix))).toBe(false)

    transport.close()
  })
})
