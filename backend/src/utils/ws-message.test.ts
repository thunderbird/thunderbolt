/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHaystackRoutes } from '@/haystack/routes'
import { createUniversalProxyWsRoutes } from '@/proxy/ws'
import { mockAuth } from '@/test-utils/mock-auth'
import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it, mock, spyOn } from 'bun:test'
import { createWSMessageParser } from 'elysia/ws'
import { encodeWsBearer } from '@shared/ws-bearer'
import { isBoundedWsJson } from './ws-message'

describe('WebSocket JSON serialization boundary', () => {
  it.each([
    ['proxy', false],
    ['proxy', true],
    ['haystack', false],
    ['haystack', true],
  ] as const)('bounds parsed JSON in %s before serialization (ready: %s)', async (kind, ready) => {
    const plugin =
      kind === 'proxy'
        ? createUniversalProxyWsRoutes({ auth: mockAuth })
        : createHaystackRoutes(createTestSettings(), mockAuth)
    const forwarded: unknown[] = []
    const state = {
      upstream: ready ? { send: (payload: unknown) => forwarded.push(payload), close: () => {} } : null,
      upstreamReady: ready,
      server: ready
        ? {
            handleMessage: async (payload: string) => {
              forwarded.push(payload)
            },
          }
        : null,
      pending: [],
      pendingBytes: 0,
      closing: false,
    }
    const ws = { data: { relay: state, __haystack: state }, close: mock((_code?: number, _reason?: string) => {}) }
    const handlers = plugin.routes.find((route) => route.method === 'WS')!.hooks.websocket as unknown as {
      message: (socket: typeof ws, message: unknown) => Promise<void> | void
    }
    const parse = createWSMessageParser([])
    const flat = '{"pad":"' + 'x'.repeat(503) + '"}'
    await handlers.message(ws, await parse(ws as never, flat))
    expect(ready ? forwarded.length : state.pending.length).toBe(1)
    expect(ready ? Buffer.byteLength(forwarded[0] as string | Uint8Array) : state.pendingBytes).toBe(513)
    if (ready) {
      await handlers.message(ws, await parse(ws as never, '{"pad":"' + 'x'.repeat(300 * 1024) + '"}'))
      expect(forwarded.length).toBe(2)
    }
    if (kind === 'proxy') {
      const binary = Buffer.from([0, 1, 255])
      await handlers.message(ws, await parse(ws as never, binary))
      const binaryPayload = ready ? forwarded.at(-1) : state.pending.at(-1)
      expect(binaryPayload).toBe(binary)
    }

    const stringify = spyOn(JSON, 'stringify')
    try {
      await handlers.message(ws, await parse(ws as never, '['.repeat(256) + '0' + ']'.repeat(256)))
      expect(stringify.mock.calls.some(([value]) => Array.isArray(value))).toBe(false)
      expect(state.closing).toBe(true)
      expect(ws.close.mock.calls[0]?.[0]).toBe(ready ? 1009 : 4008)
      expect(state.pending.length).toBe(0)
    } finally {
      stringify.mockRestore()
    }
  })

  it.each([
    [false, Buffer.from([0, 1, 255])],
    [true, Buffer.from([0, 1, 255])],
    [false, new Uint8Array([0, 1, 255])],
    [true, new Uint8Array([0, 1, 255])],
    [false, new Uint8Array([0, 1, 255]).buffer],
    [true, new Uint8Array([0, 1, 255]).buffer],
  ] as const)('rejects Haystack binary before serialization (ready: %s, binary: %s)', async (ready, binary) => {
    const plugin = createHaystackRoutes(createTestSettings(), mockAuth)
    const forwarded: string[] = []
    const state = {
      server: ready
        ? {
            handleMessage: async (payload: string) => {
              forwarded.push(payload)
            },
          }
        : null,
      pending: [],
      pendingBytes: 0,
      closing: false,
    }
    const ws = { data: { __haystack: state }, close: mock((_code?: number, _reason?: string) => {}) }
    const handlers = plugin.routes.find((route) => route.method === 'WS')!.hooks.websocket as unknown as {
      message: (socket: typeof ws, message: unknown) => Promise<void> | void
    }
    const parse = createWSMessageParser([])
    const text = '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
    await handlers.message(ws, await parse(ws as never, text))
    expect(ready ? forwarded : state.pending).toEqual([text])
    expect(state.closing).toBe(false)

    const parsedBinary = await parse(ws as never, binary)
    const stringify = spyOn(JSON, 'stringify')
    try {
      await handlers.message(ws, parsedBinary)
      expect(stringify.mock.calls.length).toBe(0)
      expect(state.closing).toBe(true)
      expect(ws.close.mock.calls[0]?.[0]).toBe(ready ? 1009 : 4008)
      expect(state.pending).toEqual([])
      expect(state.pendingBytes).toBe(0)
      expect(forwarded).toEqual(ready ? [text] : [])
    } finally {
      stringify.mockRestore()
    }
  })

  it.each(['proxy', 'haystack'])('rejects oversized parsed JSON in %s before stringify', async (kind) => {
    const plugin =
      kind === 'proxy'
        ? createUniversalProxyWsRoutes({ auth: mockAuth })
        : createHaystackRoutes(createTestSettings(), mockAuth)
    const state = { upstream: null, upstreamReady: false, server: null, pending: [], pendingBytes: 0, closing: false }
    const ws = { data: { relay: state, __haystack: state }, close: mock((_code?: number, _reason?: string) => {}) }
    const handlers = plugin.routes.find((route) => route.method === 'WS')!.hooks.websocket as unknown as {
      message: (socket: typeof ws, message: unknown) => Promise<void> | void
    }
    const stringify = spyOn(JSON, 'stringify')
    try {
      await handlers.message(ws, { pad: 'x'.repeat(256 * 1024) })
      expect(stringify.mock.calls.length).toBe(0)
      expect(ws.close.mock.calls[0]?.[0]).toBe(4008)
    } finally {
      stringify.mockRestore()
    }
  })

  it.each(['proxy', 'haystack'])('keeps exact queue accounting in %s after the structural preflight', async (kind) => {
    const plugin =
      kind === 'proxy'
        ? createUniversalProxyWsRoutes({ auth: mockAuth })
        : createHaystackRoutes(createTestSettings(), mockAuth)
    const state = { upstream: null, upstreamReady: false, server: null, pending: [], pendingBytes: 0, closing: false }
    const ws = { data: { relay: state, __haystack: state }, close: mock((_code?: number, _reason?: string) => {}) }
    const handlers = plugin.routes.find((route) => route.method === 'WS')!.hooks.websocket as unknown as {
      message: (socket: typeof ws, message: unknown) => Promise<void> | void
    }
    await handlers.message(ws, { pad: 'x'.repeat(256 * 1024 - 10) })
    expect(state.pendingBytes).toBe(256 * 1024)
    expect(state.closing).toBe(false)
    await handlers.message(ws, 'x')
    expect(ws.close.mock.calls[0]?.[0]).toBe(4008)

    const escapedState = {
      upstream: null,
      upstreamReady: false,
      server: null,
      pending: [],
      pendingBytes: 0,
      closing: false,
    }
    const escapedWs = { ...ws, data: { relay: escapedState, __haystack: escapedState } }
    await handlers.message(escapedWs, { pad: '\0'.repeat(48 * 1024) })
    expect(escapedState.closing).toBe(true)
    expect(escapedState.pendingBytes).toBe(0)
  })

  it.each(['proxy', 'haystack'])('keeps malformed-bearer auth closed in %s', async (kind) => {
    const plugin =
      kind === 'proxy'
        ? createUniversalProxyWsRoutes({ auth: mockAuth })
        : createHaystackRoutes(createTestSettings(), mockAuth)
    const ws = {
      data: {
        request: new Request('http://localhost/ws', {
          headers: { 'sec-websocket-protocol': `thunderbolt.bearer.${encodeWsBearer('bad\r\ntoken')}` },
        }),
      },
      close: mock((_code?: number, _reason?: string) => {}),
    }
    const handlers = plugin.routes.find((route) => route.method === 'WS')!.hooks.websocket as unknown as {
      open: (socket: typeof ws) => Promise<void>
    }
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await handlers.open(ws)
      expect(ws.close.mock.calls[0]?.[0]).toBe(1013)
    } finally {
      errors.mockRestore()
    }
  })
})

describe('isBoundedWsJson', () => {
  it('accepts 128 containers and rejects the next before descending', () => {
    expect(isBoundedWsJson(JSON.parse('['.repeat(128) + '0' + ']'.repeat(128)))).toBe(true)
    expect(isBoundedWsJson(JSON.parse('['.repeat(129) + '0' + ']'.repeat(129)))).toBe(false)
    expect(isBoundedWsJson(JSON.parse('{"x":'.repeat(129) + '0' + '}'.repeat(129)))).toBe(false)
  })

  it('counts UTF-8 strings, keys and wide arrays against the budget', () => {
    expect(isBoundedWsJson({ é: '🙂' }, 12)).toBe(true)
    expect(isBoundedWsJson({ é: '🙂' }, 11)).toBe(false)
    expect(isBoundedWsJson(Array(100).fill(null), 64)).toBe(false)
    expect(isBoundedWsJson({ a: 1, b: 2, c: 3 }, 8)).toBe(false)
  })

  it('bounds cycles and binary buffers without changing their representation', () => {
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(isBoundedWsJson(cyclic)).toBe(false)
    expect(isBoundedWsJson(Buffer.from([0, 1, 255]), 3)).toBe(true)
    expect(isBoundedWsJson(Buffer.from([0, 1, 255]), 2)).toBe(false)
  })
})
