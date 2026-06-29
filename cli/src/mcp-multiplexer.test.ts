/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect, mock, type Mock } from 'bun:test'
import { createMultiplexer } from './mcp-multiplexer'
import type { JsonRpcId, JsonRpcMessage, McpTransport, McpTransportClass, Multiplexer } from './types'

/** A silent PII-safe logger spy. */
const makeLogger = () => ({
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  banner: mock(() => {}),
})

/** The test's view of a per-request transport once the mux has wired its onmessage. */
type FakeTransport = {
  onmessage: (message: JsonRpcMessage) => void
  send: Mock<(message: JsonRpcMessage) => Promise<void>>
  close: Mock<() => Promise<void>>
}

/** A fake per-request transport: captures sent frames; onmessage is wired by the mux. */
const makeTransport = () => ({
  onmessage: null as ((message: JsonRpcMessage) => void) | null,
  send: mock((_message: JsonRpcMessage) => Promise.resolve()),
  close: mock(() => Promise.resolve()),
})

/** A fake StreamableHTTPServerTransport class the mux instantiates per request. */
const TransportClass = class {
  constructor() {
    return makeTransport()
  }
} as unknown as McpTransportClass

/** Create a per-request transport and view it as the FakeTransport the test drives. */
const create = (mux: Multiplexer): FakeTransport => mux.createTransport(TransportClass) as unknown as FakeTransport

/** Build a mux whose child writes are captured as parsed frames. */
const makeMux = () => {
  const logger = makeLogger()
  const written: JsonRpcMessage[] = []
  const mux = createMultiplexer({
    writeChild: (frame: string) => written.push(JSON.parse(frame.replace(/\n$/, ''))),
    logger,
  })
  return { mux, written, logger }
}

/** A standard client initialize request. */
const initRequest = (id: JsonRpcId): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
})

/** The child's initialize result payload (capabilities/serverInfo/protocolVersion). */
const childInitResult = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'everything', version: '2.0.0' },
}

test('the FIRST client initialize is forwarded to the child exactly once (id remapped)', () => {
  const { mux, written } = makeMux()
  const t = create(mux)
  t.onmessage(initRequest(1))
  expect(written).toHaveLength(1)
  expect(written[0].method).toBe('initialize')
  expect(written[0].id).not.toBe(1) // remapped to a global id
  expect(typeof written[0].id).toBe('string')
})

test('the child initialize result is cached and answered to the first client with its id', () => {
  const { mux, written } = makeMux()
  const t = create(mux)
  t.onmessage(initRequest(1))
  const globalId = written[0].id
  mux.onChildMessage({ jsonrpc: '2.0', id: globalId, result: childInitResult })
  expect(t.send).toHaveBeenCalledTimes(1)
  expect(t.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 1, result: childInitResult })
})

test('a SECOND client initialize is NOT forwarded to the child and is answered from cache with its own id', () => {
  const { mux, written } = makeMux()
  const t1 = create(mux)
  t1.onmessage(initRequest(1))
  const globalId = written[0].id
  mux.onChildMessage({ jsonrpc: '2.0', id: globalId, result: childInitResult })

  // Second client (a fresh transport) initializes: the child must NOT see it.
  const t2 = create(mux)
  t2.onmessage(initRequest(99))
  expect(written).toHaveLength(1) // STILL just the first forwarded initialize
  expect(t2.send).toHaveBeenCalledTimes(1)
  expect(t2.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 99, result: childInitResult })
})

test('a concurrent initialize that races in BEFORE the child answers is queued and answered from cache (not forwarded)', () => {
  const { mux, written } = makeMux()
  const t1 = create(mux)
  const t2 = create(mux)
  // Both initialize before the child has replied to the first.
  t1.onmessage(initRequest(10))
  t2.onmessage(initRequest(20))
  // Only ONE initialize reached the child.
  expect(written).toHaveLength(1)
  const globalId = written[0].id
  // Neither has been answered yet.
  expect(t1.send).not.toHaveBeenCalled()
  expect(t2.send).not.toHaveBeenCalled()
  // The child answers; both waiters are served from the cached result, each with
  // its own client id.
  mux.onChildMessage({ jsonrpc: '2.0', id: globalId, result: childInitResult })
  expect(t1.send).toHaveBeenCalledTimes(1)
  expect(t1.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 10, result: childInitResult })
  expect(t2.send).toHaveBeenCalledTimes(1)
  expect(t2.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 20, result: childInitResult })
})

test('the FIRST notifications/initialized is forwarded; duplicates are swallowed', () => {
  const { mux, written } = makeMux()
  const t1 = create(mux)
  const t2 = create(mux)
  t1.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
  t2.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
  // Only the first reaches the child (server-everything would otherwise be confused).
  const initializedFrames = written.filter((f) => f.method === 'notifications/initialized')
  expect(initializedFrames).toHaveLength(1)
})

test('a client request id is remapped to a global id and the response routes home to the right transport', () => {
  const { mux, written } = makeMux()
  const t1 = create(mux)
  const t2 = create(mux)
  // Both clients use the SAME local id (1) — the classic collision the remap fixes.
  t1.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  t2.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  expect(written).toHaveLength(2)
  const [g1, g2] = written.map((f) => f.id)
  expect(g1).not.toBe(g2) // distinct global ids despite identical client ids

  // The child answers each global id; each response routes to ITS transport as id 1.
  mux.onChildMessage({ jsonrpc: '2.0', id: g2, result: { tools: ['b'] } })
  mux.onChildMessage({ jsonrpc: '2.0', id: g1, result: { tools: ['a'] } })
  expect(t1.send).toHaveBeenCalledTimes(1)
  expect(t1.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: ['a'] } })
  expect(t2.send).toHaveBeenCalledTimes(1)
  expect(t2.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: ['b'] } })
})

test('an id-less child notification is broadcast to every LIVE transport', () => {
  const { mux } = makeMux()
  const t1 = create(mux)
  const t2 = create(mux)
  mux.onChildMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  expect(t1.send).toHaveBeenCalledTimes(1)
  expect(t2.send).toHaveBeenCalledTimes(1)
  expect(t1.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
})

test('a released transport no longer receives broadcasts and its pending route is cancelled', () => {
  const { mux, written } = makeMux()
  const t1 = create(mux)
  const t2 = create(mux)
  t1.onmessage({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })
  const g1 = written[0].id
  mux.releaseTransport(t1 as unknown as McpTransport)
  // Broadcast reaches only t2 now.
  mux.onChildMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  expect(t1.send).not.toHaveBeenCalled()
  expect(t2.send).toHaveBeenCalledTimes(1)
  // A late response for t1's cancelled pending route is dropped (no throw, logged).
  mux.onChildMessage({ jsonrpc: '2.0', id: g1, result: {} })
  expect(t1.send).not.toHaveBeenCalled()
})

test('a child error reply to the forwarded initialize is relayed to the waiter and resets so a later initialize retries', () => {
  const { mux, written } = makeMux()
  const t = create(mux)
  t.onmessage(initRequest(1))
  const globalId = written[0].id
  // The child rejects the initialize with an error (no result): it must NOT be
  // cached. The error is relayed to the waiting client (re-stamped with its id).
  mux.onChildMessage({ jsonrpc: '2.0', id: globalId, error: { code: -32000, message: 'boom' } })
  expect(t.send).toHaveBeenCalledTimes(1)
  expect(t.send.mock.calls[0][0]).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })

  // The init state reset, so a subsequent initialize re-forwards to the child
  // (the cache never populated) — a single failure can't wedge every future client.
  const t2 = create(mux)
  t2.onmessage(initRequest(2))
  expect(written).toHaveLength(2)
  expect(written[1].method).toBe('initialize')
})

test('closeAll closes every live transport and clears pending routes', () => {
  const { mux, written } = makeMux()
  const t1 = create(mux)
  const t2 = create(mux)
  t1.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  mux.closeAll()
  expect(t1.close).toHaveBeenCalledTimes(1)
  expect(t2.close).toHaveBeenCalledTimes(1)
  // A late response after closeAll routes nowhere (pending cleared) — no throw.
  const g1 = written[0].id
  expect(() => mux.onChildMessage({ jsonrpc: '2.0', id: g1, result: {} })).not.toThrow()
})
