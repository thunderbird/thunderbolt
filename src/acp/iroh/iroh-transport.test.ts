/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh transport tests. A fake `IrohClientLike` stands in for the wasm client —
 * no relay, no wasm — so the ndjson framing and `Stream` adaptation are exercised
 * directly. The shared client is reset between cases.
 */

import type { AnyMessage } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'bun:test'
import { resetSharedIrohClientForTests, acpIrohAlpn, openIrohTransport } from './iroh-transport'
import type { IrohClientLike, IrohConnectionLike } from './types'

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

afterEach(() => {
  resetSharedIrohClientForTests()
})

describe('openIrohTransport', () => {
  it('dials the target over the ACP ALPN', async () => {
    const fake = makeFakeConnection()
    const captured: CapturedConnect[] = []
    await openIrohTransport({
      target: 'ticket-or-nodeid',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, captured),
    })
    expect(captured).toEqual([{ target: 'ticket-or-nodeid', alpn: acpIrohAlpn }])
  })

  it('frames an outbound message as ndjson on the send half', async () => {
    const fake = makeFakeConnection()
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const writer = transport.stream.writable.getWriter()
    await writer.write({ jsonrpc: '2.0', id: 1, method: 'initialize' } as unknown as AnyMessage)
    expect(fake.sent().map((b) => new TextDecoder().decode(b))).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    ])
  })

  it('decodes inbound ndjson bytes into ACP messages on the readable', async () => {
    const fake = makeFakeConnection()
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const reader = transport.stream.readable.getReader()
    fake.pushBytes(enc('{"jsonrpc":"2.0","id":1,"result":{}}\n'))
    const { value } = await reader.read()
    expect(value).toEqual({ jsonrpc: '2.0', id: 1, result: {} } as unknown as AnyMessage)
  })

  it('reassembles a message split across two receive chunks', async () => {
    const fake = makeFakeConnection()
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const reader = transport.stream.readable.getReader()
    fake.pushBytes(enc('{"jsonrpc":"2.0",'))
    fake.pushBytes(enc('"id":7}\n'))
    const { value } = await reader.read()
    expect(value).toEqual({ jsonrpc: '2.0', id: 7 } as unknown as AnyMessage)
  })

  it('resolves `closed` cleanly when the receive stream ends', async () => {
    const fake = makeFakeConnection()
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    fake.endReceive()
    await expect(transport.closed).resolves.toBeUndefined()
  })

  it('rejects `closed` when the receive stream errors', async () => {
    const fake = makeFakeConnection()
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    fake.errorReceive(new Error('relay dropped'))
    await expect(transport.closed).rejects.toThrow('relay dropped')
  })

  it('closes the readable on close() and ignores inbound bytes that arrive after', async () => {
    const fake = makeFakeConnection()
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    const reader = transport.stream.readable.getReader()
    transport.close()
    // A late frame from the wire must not throw (the pump is guarded).
    fake.pushBytes(enc('{"late":true}\n'))
    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  it('close() closes the underlying connection and settles `closed`', async () => {
    const fake = makeFakeConnection()
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    transport.close()
    expect(fake.closed()).toBe(true)
    await expect(transport.closed).resolves.toBeUndefined()
  })

  it('aborting the signal closes the connection', async () => {
    const fake = makeFakeConnection()
    const controller = new AbortController()
    await openIrohTransport({
      target: 't',
      signal: controller.signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    controller.abort()
    expect(fake.closed()).toBe(true)
  })

  it('rejects with AbortError and closes the connection if aborted during the dial', async () => {
    const fake = makeFakeConnection()
    const controller = new AbortController()
    controller.abort()
    await expect(
      openIrohTransport({
        target: 't',
        signal: controller.signal,
        loadClient: async () => makeFakeClient(fake.connection, []),
      }),
    ).rejects.toThrow(/abort/i)
    expect(fake.closed()).toBe(true)
  })

  it('binds ONE shared client across transports, opening a connection each', async () => {
    let binds = 0
    let connects = 0
    const loadClient = async (): Promise<IrohClientLike> => {
      binds += 1
      return {
        nodeId: () => 'shared',
        // A fresh connection per dial — each transport owns its own bidi stream.
        connect: async () => {
          connects += 1
          return makeFakeConnection().connection
        },
      }
    }
    await openIrohTransport({ target: 'a', signal: new AbortController().signal, loadClient })
    await openIrohTransport({ target: 'b', signal: new AbortController().signal, loadClient })
    expect(binds).toBe(1)
    expect(connects).toBe(2)
  })
})
