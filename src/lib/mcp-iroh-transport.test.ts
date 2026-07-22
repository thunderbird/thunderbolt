/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * MCP iroh transport tests. A fake `IrohClientLike` stands in for the wasm client
 * (no relay, no wasm), so the ndjson framing and the MCP SDK `Transport`
 * adaptation are exercised directly. The shared client is reset between cases.
 * Mirrors `src/acp/iroh/iroh-transport.test.ts`.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { resetSharedIrohClientForTests } from '@/acp/iroh/iroh-transport'
import type { IrohClientLike, IrohConnectionLike } from '@/acp/iroh/types'
import { ensureSelfEnrollment, resetSelfEnrollmentForTests } from './iroh-enrollment'
import { createMcpIrohTransport, mcpIrohAlpn } from './mcp-iroh-transport'

type FakeConnection = {
  connection: IrohConnectionLike
  pushBytes: (bytes: Uint8Array) => void
  endReceive: () => void
  errorReceive: (err: Error) => void
  sent: () => Uint8Array[]
  closed: () => boolean
}

const makeFakeConnection = (): FakeConnection => {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const sent: Uint8Array[] = []
  let isClosed = false
  return {
    connection: {
      send: async (data) => {
        sent.push(data)
      },
      readable: () => readable,
      close: () => {
        isClosed = true
      },
    },
    pushBytes: (bytes) => controller?.enqueue(bytes),
    endReceive: () => controller?.close(),
    errorReceive: (err) => controller?.error(err),
    sent: () => sent,
    closed: () => isClosed,
  }
}

type CapturedConnect = { target: string; alpn: string }

const makeFakeClient = (connection: IrohConnectionLike, captured: CapturedConnect[]): IrohClientLike => ({
  nodeId: () => 'fake-node-id',
  connect: async (target, alpn) => {
    captured.push({ target, alpn })
    return connection
  },
})

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
// The global test preload installs a fake clock, so `setTimeout` never fires —
// drain microtasks instead to let the readable-stream pump deliver (the same
// enqueue→read resolution the ACP iroh test awaits directly).
const flush = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve()
  }
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize' } as unknown as JSONRPCMessage

afterEach(() => {
  resetSharedIrohClientForTests()
  resetSelfEnrollmentForTests()
})

describe('createMcpIrohTransport', () => {
  it('warns and still dials when transparent enrollment fails', async () => {
    const fake = makeFakeConnection()
    const captured: CapturedConnect[] = []
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const post = mock(async () => {
      throw new Error('403')
    })
    const ensureEnrollment: NonNullable<Parameters<typeof createMcpIrohTransport>[0]['ensureEnrollment']> = (
      httpClient,
      loadNodeId = async () => 'missing-node-id',
    ) =>
      ensureSelfEnrollment(httpClient, loadNodeId, {
        loadOwnNodeId: async () => null,
        loadDeviceId: () => 'device-1',
      })
    const transport = createMcpIrohTransport({
      target: 'ticket-or-nodeid',
      loadClient: async () => makeFakeClient(fake.connection, captured),
      httpClient: { post } as unknown as Parameters<typeof ensureSelfEnrollment>[0],
      ensureEnrollment,
    })

    try {
      await transport.start()
      expect(warn).toHaveBeenCalledWith('iroh transparent enrollment failed; using manual pairing fallback')
      expect(captured).toEqual([{ target: 'ticket-or-nodeid', alpn: mcpIrohAlpn }])
    } finally {
      warn.mockRestore()
    }
  })

  it('dials the target over the MCP ALPN on start()', async () => {
    const fake = makeFakeConnection()
    const captured: CapturedConnect[] = []
    const transport = createMcpIrohTransport({
      target: 'ticket-or-nodeid',
      loadClient: async () => makeFakeClient(fake.connection, captured),
    })
    await transport.start()
    expect(captured).toEqual([{ target: 'ticket-or-nodeid', alpn: mcpIrohAlpn }])
  })

  it('frames an outbound JSON-RPC message as ndjson on the send half', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    await transport.start()
    await transport.send(initialize)
    expect(fake.sent().map((b) => new TextDecoder().decode(b))).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    ])
  })

  it('decodes inbound ndjson bytes into onmessage', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const received: JSONRPCMessage[] = []
    transport.onmessage = (m) => received.push(m)
    await transport.start()
    fake.pushBytes(enc('{"jsonrpc":"2.0","id":1,"result":{}}\n'))
    await flush()
    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, result: {} } as unknown as JSONRPCMessage])
  })

  it('reassembles a message split across two receive chunks', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const received: JSONRPCMessage[] = []
    transport.onmessage = (m) => received.push(m)
    await transport.start()
    fake.pushBytes(enc('{"jsonrpc":"2.0",'))
    fake.pushBytes(enc('"id":7}\n'))
    await flush()
    expect(received).toEqual([{ jsonrpc: '2.0', id: 7 } as unknown as JSONRPCMessage])
  })

  it('close() closes the underlying connection and fires onclose', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    let closedCalls = 0
    transport.onclose = () => {
      closedCalls += 1
    }
    await transport.start()
    await transport.close()
    expect(fake.closed()).toBe(true)
    expect(closedCalls).toBe(1)
  })

  it('is idempotent: a second close() does not re-fire onclose', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    let closedCalls = 0
    transport.onclose = () => {
      closedCalls += 1
    }
    await transport.start()
    await transport.close()
    await transport.close()
    expect(closedCalls).toBe(1)
  })

  it('fires onclose (and no onerror) on a clean receive EOF', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    let closedCalls = 0
    let errored: Error | null = null
    transport.onclose = () => {
      closedCalls += 1
    }
    transport.onerror = (e) => {
      errored = e
    }
    await transport.start()
    fake.endReceive()
    await flush()
    expect(closedCalls).toBe(1)
    expect(errored).toBeNull()
  })

  it('surfaces a receive read error via onerror, then onclose', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const order: string[] = []
    transport.onerror = (e) => order.push(`error:${e.message}`)
    transport.onclose = () => order.push('close')
    await transport.start()
    fake.errorReceive(new Error('relay dropped'))
    await flush()
    expect(order).toEqual(['error:relay dropped', 'close'])
    expect(fake.closed()).toBe(true)
  })

  it('throws on a second start() (one-shot, like the SDK transports)', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    await transport.start()
    await expect(transport.start()).rejects.toThrow(/already started/i)
  })

  it('stops delivering remaining frames in a chunk once onmessage closes the transport', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const received: JSONRPCMessage[] = []
    // The first message synchronously closes the transport mid-batch.
    transport.onmessage = (m) => {
      received.push(m)
      void transport.close()
    }
    await transport.start()
    fake.pushBytes(enc('{"id":1}\n{"id":2}\n{"id":3}\n'))
    await flush()
    expect(received).toEqual([{ id: 1 } as unknown as JSONRPCMessage])
  })

  it('ignores inbound bytes that arrive after close (guarded pump)', async () => {
    const fake = makeFakeConnection()
    const transport = createMcpIrohTransport({
      target: 't',
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const received: JSONRPCMessage[] = []
    transport.onmessage = (m) => received.push(m)
    await transport.start()
    await transport.close()
    // A late frame from the wire must not throw or deliver after close.
    fake.pushBytes(enc('{"late":true}\n'))
    await flush()
    expect(received).toEqual([])
  })
})
