/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
})
