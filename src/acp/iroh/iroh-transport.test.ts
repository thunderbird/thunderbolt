/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh transport tests. A fake `IrohClientLike` stands in for the wasm client —
 * no relay, no wasm — so the ndjson framing and `Stream` adaptation are exercised
 * directly. The shared client is reset between cases.
 */

import type { AnyMessage } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ensureSelfEnrollment, resetSelfEnrollmentForTests } from '@/lib/iroh-enrollment'
import {
  bindAndPersistForTests,
  bindIrohClient,
  clearIrohClientSecret,
  irohRelayUrl,
  resetSharedIrohClientForTests,
  acpIrohAlpn,
  openIrohTransport,
} from './iroh-transport'
import type { IrohClientLike, IrohConnectionLike } from './types'

type FakeConnection = {
  connection: IrohConnectionLike
  pushBytes: (bytes: Uint8Array) => void
  endReceive: () => void
  errorReceive: (err: Error) => void
  sent: () => Uint8Array[]
  closed: () => boolean
  closeCount: () => number
}

const makeFakeConnection = (): FakeConnection => {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const sent: Uint8Array[] = []
  let closeCalls = 0
  return {
    connection: {
      send: async (data) => {
        sent.push(data)
      },
      readable: () => readable,
      close: () => {
        closeCalls += 1
      },
    },
    pushBytes: (bytes) => controller?.enqueue(bytes),
    endReceive: () => controller?.close(),
    errorReceive: (err) => controller?.error(err),
    sent: () => sent,
    closed: () => closeCalls > 0,
    closeCount: () => closeCalls,
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
  resetSelfEnrollmentForTests()
})

describe('openIrohTransport', () => {
  it('enrolls a synced device once before repeated dials', async () => {
    const order: string[] = []
    const client: IrohClientLike = {
      nodeId: () => 'fake-node-id',
      connect: async () => {
        order.push('dial')
        return makeFakeConnection().connection
      },
    }
    const post = mock(async () => {
      order.push('enroll-post')
      return new Response()
    })
    const httpClient = { post } as unknown as Parameters<typeof ensureSelfEnrollment>[0]
    const ensureEnrollment: NonNullable<Parameters<typeof openIrohTransport>[0]['ensureEnrollment']> = (
      enrollmentClient,
      loadNodeId = async () => 'missing-node-id',
    ) =>
      ensureSelfEnrollment(enrollmentClient, loadNodeId, {
        loadOwnNodeId: async () => null,
        loadDeviceId: () => 'device-1',
      })

    await openIrohTransport({
      target: 'first-target',
      signal: new AbortController().signal,
      loadClient: async () => client,
      httpClient,
      ensureEnrollment,
    })
    await openIrohTransport({
      target: 'second-target',
      signal: new AbortController().signal,
      loadClient: async () => client,
      httpClient,
      ensureEnrollment,
    })

    expect(order).toEqual(['enroll-post', 'dial', 'dial'])
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('devices/me/node-id', { json: { nodeId: 'fake-node-id' } })
  })

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

  it('propagates a send failure to the writable write (no silently swallowed error)', async () => {
    const fake = makeFakeConnection()
    // The wasm `send()` now rejects when the underlying QUIC write fails, instead
    // of resolving on enqueue — the writable must surface that rejection.
    const failing: IrohConnectionLike = {
      ...fake.connection,
      send: async () => {
        throw new Error('iroh connection closed')
      },
    }
    const transport = await openIrohTransport({
      target: 't',
      signal: new AbortController().signal,
      loadClient: async () => makeFakeClient(failing, []),
    })
    const writer = transport.stream.writable.getWriter()
    await expect(
      writer.write({ jsonrpc: '2.0', id: 1, method: 'initialize' } as unknown as AnyMessage),
    ).rejects.toThrow('iroh connection closed')
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

  it('routes teardown through close() on a receive error: closes the connection and detaches the abort listener', async () => {
    const fake = makeFakeConnection()
    const controller = new AbortController()
    const removeSpy = spyOn(controller.signal, 'removeEventListener')
    const transport = await openIrohTransport({
      target: 't',
      signal: controller.signal,
      loadClient: async () => makeFakeClient(fake.connection, []),
    })
    fake.errorReceive(new Error('recv blew up'))
    await expect(transport.closed).rejects.toThrow('recv blew up')
    // The error path must close the QUIC connection (no leaked connection)...
    expect(fake.closeCount()).toBe(1)
    // ...and detach the abort listener from the long-lived signal (no pinned leak).
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    // A later abort is now a no-op — the detached listener can't re-close.
    controller.abort()
    expect(fake.closeCount()).toBe(1)
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

  it('rejects with AbortError without dialing when the signal is already aborted', async () => {
    const fake = makeFakeConnection()
    const captured: CapturedConnect[] = []
    const controller = new AbortController()
    controller.abort()
    await expect(
      openIrohTransport({
        target: 't',
        signal: controller.signal,
        loadClient: async () => makeFakeClient(fake.connection, captured),
      }),
    ).rejects.toThrow(/abort/i)
    // A pre-aborted dial never reaches the wire — nothing to dial or close.
    expect(captured).toEqual([])
    expect(fake.closed()).toBe(false)
  })

  it('closes a connection that resolves after an abort during the dial', async () => {
    const fake = makeFakeConnection()
    const controller = new AbortController()
    let resolveConnect: (connection: IrohConnectionLike) => void = () => {}
    let signalDialing: () => void = () => {}
    const dialing = new Promise<void>((resolve) => {
      signalDialing = resolve
    })
    const slowClient: IrohClientLike = {
      nodeId: () => 'slow',
      connect: () => {
        signalDialing()
        return new Promise<IrohConnectionLike>((resolve) => {
          resolveConnect = resolve
        })
      },
    }
    const open = openIrohTransport({ target: 't', signal: controller.signal, loadClient: async () => slowClient })
    // Wait until the dial is actually in flight (the never-resolving connect was
    // called), then abort — no fake-timer dependency.
    await dialing
    controller.abort()
    await expect(open).rejects.toThrow(/abort/i)
    // The dial wins the race a tick too late; the orphaned connection must close.
    resolveConnect(fake.connection)
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.closed()).toBe(true)
  })

  it('evicts the shared client when the bind fails so a later dial rebinds', async () => {
    let binds = 0
    const loadClient = async (): Promise<IrohClientLike> => {
      binds += 1
      if (binds === 1) {
        throw new Error('bind failed')
      }
      return makeFakeClient(makeFakeConnection().connection, [])
    }
    await expect(openIrohTransport({ target: 'a', signal: new AbortController().signal, loadClient })).rejects.toThrow(
      'bind failed',
    )
    // The failed bind was evicted, so this rebinds instead of replaying the rejection.
    const transport = await openIrohTransport({ target: 'b', signal: new AbortController().signal, loadClient })
    expect(binds).toBe(2)
    expect(transport.stream).toBeDefined()
  })

  it('evicts the shared client when aborted during the bind so a later dial rebinds', async () => {
    let binds = 0
    let resolveBind: (client: IrohClientLike) => void = () => {}
    const loadClient = (): Promise<IrohClientLike> => {
      binds += 1
      if (binds === 1) {
        return new Promise<IrohClientLike>((resolve) => {
          resolveBind = resolve
        })
      }
      return Promise.resolve(makeFakeClient(makeFakeConnection().connection, []))
    }
    const controller = new AbortController()
    // `load()` runs synchronously inside the call and `raceAbort` attaches its
    // abort listener before suspending, so aborting right away lands during the
    // in-flight bind.
    const open = openIrohTransport({ target: 'a', signal: controller.signal, loadClient })
    controller.abort()
    await expect(open).rejects.toThrow(/abort/i)
    // The hung bind was evicted; a later dial rebinds rather than awaiting it.
    const transport = await openIrohTransport({ target: 'b', signal: new AbortController().signal, loadClient })
    expect(binds).toBe(2)
    expect(transport.stream).toBeDefined()
    // Let the orphaned first bind settle so it leaves no dangling pending promise.
    resolveBind(makeFakeClient(makeFakeConnection().connection, []))
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

describe('clearIrohClientSecret', () => {
  const secretStorageKey = 'iroh_acp_client_secret'

  it('removes the persisted client secret from localStorage', () => {
    localStorage.setItem(secretStorageKey, 'deadbeef')
    clearIrohClientSecret()
    expect(localStorage.getItem(secretStorageKey)).toBeNull()
  })

  it('drops the in-memory shared client so the next dial re-binds a fresh identity', async () => {
    let binds = 0
    const loadClient = async (): Promise<IrohClientLike> => {
      binds += 1
      return { nodeId: () => 'shared', connect: async () => makeFakeConnection().connection }
    }
    await openIrohTransport({ target: 'a', signal: new AbortController().signal, loadClient })
    expect(binds).toBe(1)
    // A wiped credential must not leave the old identity bound in memory to re-persist.
    clearIrohClientSecret()
    await openIrohTransport({ target: 'b', signal: new AbortController().signal, loadClient })
    expect(binds).toBe(2)
  })

  it('persists the bound secret when no wipe races the bind', async () => {
    localStorage.removeItem(secretStorageKey)
    const client: IrohClientLike = { nodeId: () => 'n', connect: async () => makeFakeConnection().connection }
    await bindAndPersistForTests(async () => ({ client, secretHex: 'fresh-secret' }))
    expect(localStorage.getItem(secretStorageKey)).toBe('fresh-secret')
  })

  it('does NOT re-persist a secret when a wipe (sign-out) races the in-flight bind', async () => {
    localStorage.removeItem(secretStorageKey)
    const client: IrohClientLike = { nodeId: () => 'n', connect: async () => makeFakeConnection().connection }
    let resolveBind: (value: { client: IrohClientLike; secretHex: string }) => void = () => {}
    const bindPending = bindAndPersistForTests(() => new Promise((resolve) => (resolveBind = resolve)))
    // Sign-out wipes the secret while the wasm bind is still in flight.
    clearIrohClientSecret()
    // The bind now resolves with the freshly generated secret — it must not be written back.
    resolveBind({ client, secretHex: 'resurrected-secret' })
    await bindPending
    expect(localStorage.getItem(secretStorageKey)).toBeNull()
  })
})

// `irohRelayUrl` reads `import.meta.env` on every call, so tests mutate the env
// directly (the same pattern auth-mode tests use) and clear it afterwards.
const viteEnv = import.meta.env as Record<string, string | undefined>

describe('irohRelayUrl', () => {
  afterEach(() => {
    delete viteEnv.VITE_IROH_RELAY_URL
  })

  it('is undefined when VITE_IROH_RELAY_URL is unset', () => {
    delete viteEnv.VITE_IROH_RELAY_URL
    expect(irohRelayUrl()).toBeUndefined()
  })

  it('is undefined when VITE_IROH_RELAY_URL is empty or whitespace', () => {
    viteEnv.VITE_IROH_RELAY_URL = '   '
    expect(irohRelayUrl()).toBeUndefined()
  })

  it('returns the trimmed url when VITE_IROH_RELAY_URL is set', () => {
    viteEnv.VITE_IROH_RELAY_URL = '  wss://relay.example  '
    expect(irohRelayUrl()).toBe('wss://relay.example')
  })
})

describe('bindIrohClient', () => {
  afterEach(() => {
    delete viteEnv.VITE_IROH_RELAY_URL
  })

  it('forwards VITE_IROH_RELAY_URL into create and surfaces the bound secret', async () => {
    viteEnv.VITE_IROH_RELAY_URL = 'wss://relay.example'
    const relays: Array<string | undefined> = []
    const { client, secretHex } = await bindIrohClient(async (relay) => {
      relays.push(relay)
      return {
        nodeId: () => 'node',
        connect: async () => makeFakeConnection().connection,
        secretKeyHex: () => 'bound-secret',
      }
    })
    expect(relays).toEqual(['wss://relay.example'])
    expect(secretHex).toBe('bound-secret')
    expect(client.nodeId()).toBe('node')
  })

  it('passes undefined relay (n0 default) when VITE_IROH_RELAY_URL is unset', async () => {
    delete viteEnv.VITE_IROH_RELAY_URL
    const relays: Array<string | undefined> = []
    await bindIrohClient(async (relay) => {
      relays.push(relay)
      return {
        nodeId: () => 'node',
        connect: async () => makeFakeConnection().connection,
        secretKeyHex: () => 'bound-secret',
      }
    })
    expect(relays).toEqual([undefined])
  })
})
