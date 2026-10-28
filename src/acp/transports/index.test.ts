/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transport factory dispatch tests. Verifies the agent-type routing:
 *   - `managed-acp` offers the bearer subprotocol whenever an `httpClient` is
 *     present (no `tbproxy.target.` subprotocol — it talks to the backend
 *     directly, not through the universal proxy), falling back to an
 *     unauthenticated direct connect only when no `httpClient` is wired.
 *   - `remote-acp` on Web routes through the universal proxy
 *     (subprotocol-tunnelled, bearer-authenticated).
 *   - `remote-acp` on Tauri follows Use Cloud Proxy, except loopback stays direct.
 *
 * The proxy-vs-native decision is inspected at the layer below `openTransport`
 * — we install a fake global `WebSocket` constructor and read what
 * `new WebSocket(url, protocols)` is called with. No `mock.module()` is
 * required (DI for `isStandalone` / `getAuthToken`).
 */

import '@/testing-library'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { wsTargetPrefix } from '@shared/proxy-protocol'
import { encodeBase64Url } from '@shared/base64url'
import { encodeWsBearer } from '@shared/ws-bearer'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { openTransport } from './index'
import { type WebSocketEventMap } from './websocket'

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

let originalWebSocket: typeof WebSocket
let originalCloudUrl: string
let originalProxyEnabled: string | null
let originalStoredSettings: string | null

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket
  originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
  originalStoredSettings = localStorage.getItem('thunderbolt-local-settings')
  originalProxyEnabled = localStorage.getItem('proxy_enabled')
  localStorage.removeItem('proxy_enabled')
  FakeBrowserSocket.reset()
  // Cast through unknown — FakeBrowserSocket only implements the surface the
  // transport uses, not the full DOM `WebSocket` interface.
  globalThis.WebSocket = FakeBrowserSocket as unknown as typeof WebSocket
  useLocalSettingsStore.setState({ cloudUrl: 'http://cloud.test/v1' })
})

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
  useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
  for (const [key, value] of [
    ['proxy_enabled', originalProxyEnabled],
    ['thunderbolt-local-settings', originalStoredSettings],
  ] as const) {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  }
})

// A minimal HttpClient stub — its mere presence signals an authenticated cloud
// backend is wired; the transport never reaches into it for auth (the bearer
// rides the WS subprotocol). Methods are no-ops cast through unknown.
const stubHttpClient = {
  get: () => Promise.resolve(new Response()),
  post: () => Promise.resolve(new Response()),
  delete: () => Promise.resolve(new Response()),
} as unknown as Parameters<typeof openTransport>[0]['httpClient']

describe('openTransport — agent-type routing', () => {
  it('managed-acp on Web offers thunderbolt.v1 + thunderbolt.bearer.<token>', async () => {
    const transport = await openTransport({
      url: 'wss://cloud.test/v1/haystack/ws?pipeline=p1',
      transport: 'websocket',
      agentType: 'managed-acp',
      signal: new AbortController().signal,
      isStandalone: () => false,
      httpClient: stubHttpClient,
      getAuthToken: () => 'token-abc',
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.url).toBe('wss://cloud.test/v1/haystack/ws?pipeline=p1')
    expect(socket.protocols).toContain('thunderbolt.v1')
    expect(socket.protocols).toContain(`thunderbolt.bearer.${encodeWsBearer('token-abc')}`)
    expect(socket.protocols.some((p) => p.startsWith(wsTargetPrefix))).toBe(false)

    transport.close()
  })

  it('managed-acp on Tauri Connected (proxy OFF) still offers the bearer against the backend', async () => {
    // The "proxy toggle" governs external-traffic routing, not auth against
    // the cloud backend that hosts managed-acp. A Tauri user with the toggle
    // OFF is still authenticated against `httpClient`, so the transport must
    // offer the bearer — bailing here is the bug that surfaced as 4001
    // `unauthorized` in production on Tauri desktop.
    const transport = await openTransport({
      url: 'wss://cloud.test/v1/haystack/ws?pipeline=p1',
      transport: 'websocket',
      agentType: 'managed-acp',
      signal: new AbortController().signal,
      isStandalone: () => true,
      httpClient: stubHttpClient,
      getAuthToken: () => 'tauri-token-456',
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.protocols).toEqual(['thunderbolt.v1', `thunderbolt.bearer.${encodeWsBearer('tauri-token-456')}`])

    transport.close()
  })

  it('managed-acp with no httpClient falls back to a direct connect (graceful)', async () => {
    const transport = await openTransport({
      url: 'wss://cloud.test/v1/haystack/ws?pipeline=p1',
      transport: 'websocket',
      agentType: 'managed-acp',
      signal: new AbortController().signal,
      isStandalone: () => false,
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.protocols).toHaveLength(0)

    transport.close()
  })

  it('managed-acp with an httpClient but no token offers only the carrier', async () => {
    // Edge case: backend is wired but the bearer hasn't landed yet. We still
    // advertise the carrier so the upgrade completes; the server then closes
    // 4001 because no bearer entry was offered.
    const transport = await openTransport({
      url: 'wss://cloud.test/v1/haystack/ws?pipeline=p1',
      transport: 'websocket',
      agentType: 'managed-acp',
      signal: new AbortController().signal,
      isStandalone: () => false,
      httpClient: stubHttpClient,
      getAuthToken: () => null,
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.protocols).toEqual(['thunderbolt.v1'])

    transport.close()
  })

  it.each([
    [false, null],
    [false, 'false'],
    [false, 'true'],
    [true, 'true'],
  ] as const)('remote-acp (Tauri=%s) with proxy setting %s uses the tunnel', async (standalone, stored) => {
    if (stored === null) {
      localStorage.removeItem('proxy_enabled')
    } else {
      localStorage.setItem('proxy_enabled', stored)
    }
    const transport = await openTransport({
      url: 'wss://agent.example.com/acp',
      transport: 'websocket',
      agentType: 'remote-acp',
      signal: new AbortController().signal,
      isStandalone: () => standalone,
      // Browser WS can't attach `Authorization` headers — the proxy upgrade is
      // authenticated by the bearer token as a Sec-WebSocket-Protocol entry.
      httpClient: stubHttpClient,
      getAuthToken: () => 'proxy-token-xyz',
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.url).toBe('ws://cloud.test/v1/proxy/ws')
    expect(socket.protocols).toEqual([
      'thunderbolt.v1',
      `thunderbolt.bearer.${encodeWsBearer('proxy-token-xyz')}`,
      `${wsTargetPrefix}${encodeBase64Url('wss://agent.example.com/acp')}`,
    ])

    transport.close()
  })

  it.each([
    [null, 'wss://agent.example.com/acp'],
    ['false', 'wss://agent.example.com/acp'],
    ['true', 'ws://127.0.0.1:8839/?token=bridge-token'],
  ])('remote-acp on Tauri with proxy setting %s connects directly to %s', async (stored, url) => {
    if (stored === null) {
      localStorage.removeItem('proxy_enabled')
    } else {
      localStorage.setItem('proxy_enabled', stored)
    }
    const transport = await openTransport({
      url,
      transport: 'websocket',
      agentType: 'remote-acp',
      signal: new AbortController().signal,
      isStandalone: () => true,
      getAuthToken: () => 'backend-only-token',
    })

    expect(FakeBrowserSocket.instances).toHaveLength(1)
    const socket = FakeBrowserSocket.instances[0]
    expect(socket.url).toBe(url)
    expect(socket.protocols).toEqual([])

    transport.close()
  })
})
