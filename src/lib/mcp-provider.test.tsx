/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { MCPClient } from '@ai-sdk/mcp'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { MCPProvider, useMCP, type MCPClient as ProviderMCPClient } from './mcp-provider'

/** A `Deferred` lets a test hold a fake `createClient` open so two concurrent
 *  reconnects (or a remove mid-reconnect) overlap deterministically. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Minimal `MCPClient` fake. `close` is a tracked function so we can assert the
 *  provider closes orphaned clients. */
const fakeClient = (): MCPClient & { closeCount: () => number } => {
  let closed = 0
  return {
    tools: async () => ({}),
    close: () => {
      closed++
    },
    closeCount: () => closed,
  } as unknown as MCPClient & { closeCount: () => number }
}

const server = { id: 's1', name: 'Server 1', url: 'https://example.test/mcp', type: 'http' as const, enabled: true }

const renderProvider = (createClient: (id: string, url: string, type: 'http' | 'sse') => Promise<MCPClient>) => {
  const queryWrapper = createQueryTestWrapper()
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(queryWrapper, null, createElement(MCPProvider, { createClient, children }))
  return renderHook(() => useMCP(), { wrapper })
}

describe('MCPProvider reconnect', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('coalesces concurrent reconnects of the same server into one createClient call', async () => {
    const initial = fakeClient()
    const reconnected = fakeClient()
    let calls = 0
    const gate = deferred<void>()

    const createClient = async (): Promise<MCPClient> => {
      calls++
      if (calls === 1) {
        return initial
      }
      // Hold the reconnect open so both concurrent calls observe the in-flight promise.
      await gate.promise
      return reconnected
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
    })
    expect(calls).toBe(1)

    const results: Array<ProviderMCPClient | null> = []
    await act(async () => {
      const a = result.current.reconnectServer(server.id)
      const b = result.current.reconnectServer(server.id)
      gate.resolve()
      results.push(...(await Promise.all([a, b])))
    })

    // Two concurrent reconnects collapsed to a single createClient invocation.
    expect(calls).toBe(2)
    expect(results[0]).toBe(reconnected as unknown as ProviderMCPClient)
    expect(results[1]).toBe(reconnected as unknown as ProviderMCPClient)
  })

  it('adds a server only once when the same id is added twice (no double connection)', async () => {
    let calls = 0
    const createClient = async (): Promise<MCPClient> => {
      calls++
      return fakeClient()
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
      await result.current.addServer(server)
    })

    // The idempotency guard kept the second add from registering a duplicate
    // entry or opening a second connection.
    expect(result.current.servers.filter((s) => s.id === server.id)).toHaveLength(1)
    expect(calls).toBe(1)
    expect(result.current.getEnabledClients()).toHaveLength(1)
  })

  it('returns enabled clients as { name, client } pairs for tool namespacing', async () => {
    const client = fakeClient()
    const createClient = async (): Promise<MCPClient> => client

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
    })

    const enabled = result.current.getEnabledClients()
    expect(enabled).toHaveLength(1)
    expect(enabled[0].name).toBe(server.name)
    expect(enabled[0].client).toBe(client as unknown as ProviderMCPClient)
  })

  it('closes the orphan and returns null when the server is removed mid-reconnect', async () => {
    const initial = fakeClient()
    const orphan = fakeClient()
    let calls = 0
    const gate = deferred<void>()

    const createClient = async (): Promise<MCPClient> => {
      calls++
      if (calls === 1) {
        return initial
      }
      await gate.promise
      return orphan
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
    })

    const results: Array<ProviderMCPClient | null> = []
    await act(async () => {
      const pending = result.current.reconnectServer(server.id)
      // Remove the server while the reconnect's createClient is still in flight.
      result.current.removeServer(server.id)
      gate.resolve()
      results.push(await pending)
    })

    expect(results[0]).toBeNull()
    // The freshly created client had nowhere to go → it was closed.
    expect(orphan.closeCount()).toBe(1)
  })

  // UNIT 1 (#3): a connect resolving after the server was removed/disabled
  // mid-flight must close the orphan and not cache/commit/re-enable it.
  it('closes the orphan and does not re-add the server when removed mid-connect', async () => {
    const orphan = fakeClient()
    const gate = deferred<void>()
    const createClient = async (): Promise<MCPClient> => {
      await gate.promise
      return orphan
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      const pending = result.current.addServer(server)
      // Remove the server while the initial connect's createClient is in flight.
      result.current.removeServer(server.id)
      gate.resolve()
      await pending
    })

    expect(orphan.closeCount()).toBe(1)
    expect(result.current.getEnabledClients()).toHaveLength(0)
    expect(result.current.servers.some((s) => s.id === server.id)).toBe(false)
  })

  it('closes the orphan and does not re-enable the server when disabled mid-connect', async () => {
    const orphan = fakeClient()
    const gate = deferred<void>()
    const createClient = async (): Promise<MCPClient> => {
      await gate.promise
      return orphan
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      const pending = result.current.addServer(server)
      // Disable the server while the initial connect's createClient is in flight.
      result.current.updateServerStatus(server.id, false)
      gate.resolve()
      await pending
    })

    expect(orphan.closeCount()).toBe(1)
    expect(result.current.servers.find((s) => s.id === server.id)?.enabled).toBe(false)
    expect(result.current.getEnabledClients()).toHaveLength(0)
  })

  // UNIT 1 (#2): the addServer→connect vs updateServerStatus(enable)→connect
  // race. Without coalescing the second connect would cacheClient over the
  // first live client without closing it, leaking the first connection.
  it('coalesces overlapping connects for the same server (no leaked client)', async () => {
    const created: Array<ReturnType<typeof fakeClient>> = []
    const gate = deferred<void>()
    const createClient = async (): Promise<MCPClient> => {
      await gate.promise
      const c = fakeClient()
      created.push(c)
      return c
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      // addServer fires the first connect; a concurrent enable re-fires it.
      const a = result.current.addServer(server)
      result.current.updateServerStatus(server.id, true)
      gate.resolve()
      await a
    })

    // Both connect calls collapsed into one createClient invocation.
    expect(created).toHaveLength(1)
    // Every created client is either the live enabled client or was closed —
    // nothing leaked.
    const enabled = result.current.getEnabledClients()
    expect(enabled).toHaveLength(1)
    created.forEach((c) => {
      const isLive = enabled.some((e) => e.client === (c as unknown as ProviderMCPClient))
      expect(isLive || c.closeCount() > 0).toBe(true)
    })
  })

  // UNIT 1 (#6): a reconnect whose createClient rejects after the server was
  // disabled mid-flight must NOT commit an error onto the now-disabled row.
  it('does not commit a reconnect error onto a server disabled mid-reconnect', async () => {
    const initial = fakeClient()
    let calls = 0
    const gate = deferred<void>()
    const createClient = async (): Promise<MCPClient> => {
      calls++
      if (calls === 1) {
        return initial
      }
      await gate.promise
      throw new Error('reconnect boom')
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
    })

    await act(async () => {
      const pending = result.current.reconnectServer(server.id)
      // Disable the server while the reconnect's createClient is still pending.
      result.current.updateServerStatus(server.id, false)
      gate.resolve()
      await pending
    })

    const row = result.current.servers.find((s) => s.id === server.id)
    expect(row?.enabled).toBe(false)
    // The error must not have been committed onto the disabled row.
    expect(row?.error).toBeNull()
  })

  it('chat store reading clients fresh sees the reconnected client, not a stale snapshot', async () => {
    const initial = fakeClient()
    const reconnected = fakeClient()
    let calls = 0
    const createClient = async (): Promise<MCPClient> => {
      calls++
      return calls === 1 ? initial : reconnected
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
    })

    // Mirror hydration: store the provider's getter (not a snapshot). This is
    // the contract `use-hydrate-chat-store` relies on for option B.
    useChatStore.getState().setGetMcpClients(result.current.getEnabledClients)

    const before = useChatStore.getState().getMcpClients()
    expect(before[0].client).toBe(initial as unknown as ProviderMCPClient)

    // A drop forces a reconnect that swaps the client reference (C1 → C2).
    await act(async () => {
      await result.current.reconnectServer(server.id)
    })

    // The next send reads fresh: it must see the reconnected client. A stale
    // snapshot would still return `initial` (the closed client) — the bug.
    const after = useChatStore.getState().getMcpClients()
    expect(after[0].client).toBe(reconnected as unknown as ProviderMCPClient)
    expect(after[0].client).not.toBe(initial as unknown as ProviderMCPClient)
  })
})
