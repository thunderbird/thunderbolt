/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { setMcpServerCredentials } from '@/dal/mcp-secrets'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { MCPClient } from '@ai-sdk/mcp'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import type { ensureValidMcpOAuthToken } from './mcp-auth/ensure-valid-token'
import { MCPProvider, resolveMcpAccessToken, useMCP, type MCPClient as ProviderMCPClient } from './mcp-provider'

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
      result.current.updateServer({ ...server, enabled: false })
      gate.resolve()
      await pending
    })

    expect(orphan.closeCount()).toBe(1)
    expect(result.current.servers.find((s) => s.id === server.id)?.enabled).toBe(false)
    expect(result.current.getEnabledClients()).toHaveLength(0)
  })

  // UNIT 1 (#2): the addServer→connect vs updateServer(enable)→connect race.
  // Without coalescing the second connect would cacheClient over the first
  // live client without closing it, leaking the first connection.
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
      // addServer fires the first connect; a concurrent enable patch re-fires it.
      const a = result.current.addServer(server)
      result.current.updateServer({ ...server, enabled: true })
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
      result.current.updateServer({ ...server, enabled: false })
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

  // Settings can edit a server in-place (rename, new url/transport, new bearer
  // token). The provider had no patch path, so the live client kept dialing the
  // old endpoint while the UI showed the new config — `updateServer` closes the
  // stale client, patches state, and redials so a save actually takes effect.
  it('patches url+name and reconnects the live client on updateServer', async () => {
    const initial = fakeClient()
    const refreshed = fakeClient()
    let calls = 0
    const seenArgs: Array<{ url: string }> = []
    const createClient = async (_id: string, url: string): Promise<MCPClient> => {
      calls++
      seenArgs.push({ url })
      return calls === 1 ? initial : refreshed
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
    })
    expect(seenArgs[0].url).toBe(server.url)

    await act(async () => {
      result.current.updateServer({ ...server, name: 'Renamed', url: 'https://new.test/mcp' })
      // Reconnect kicks off synchronously; await its in-flight promise via a
      // follow-up reconnectServer call (coalesces into the same promise).
      await result.current.reconnectServer(server.id)
    })

    // Stale client closed, fresh one cached with the new URL fed to createClient.
    expect(initial.closeCount()).toBe(1)
    expect(seenArgs[1].url).toBe('https://new.test/mcp')
    const after = result.current.servers.find((s) => s.id === server.id)
    expect(after?.name).toBe('Renamed')
    expect(after?.url).toBe('https://new.test/mcp')
    expect(after?.client).toBe(refreshed as unknown as ProviderMCPClient)
  })

  it('disconnects without redialing when updateServer flips enabled to false', async () => {
    const initial = fakeClient()
    let calls = 0
    const createClient = async (): Promise<MCPClient> => {
      calls++
      return initial
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      await result.current.addServer(server)
    })
    expect(calls).toBe(1)

    await act(async () => {
      result.current.updateServer({ ...server, enabled: false })
    })

    // No second createClient (no reconnect on a disabled patch) and the old client closed.
    expect(calls).toBe(1)
    expect(initial.closeCount()).toBe(1)
    const after = result.current.servers.find((s) => s.id === server.id)
    expect(after?.enabled).toBe(false)
    expect(after?.client).toBeNull()
    expect(after?.isConnected).toBe(false)
  })

  // Credential-only edits (same url + transport) saved while the initial
  // connect is still in-flight must redial after that connect settles —
  // otherwise the live client keeps using credentials captured at the start
  // of the original connect, and the new bearer/OAuth value sits unused in
  // `mcp_secrets`. The settings save path opts in via `forceRedial`; without
  // it (the useMcpSync row-diff path) the in-flight guard still suppresses
  // redundant connects.
  it('redials after the in-flight connect settles when updateServer is called with forceRedial', async () => {
    const initial = fakeClient()
    const refreshed = fakeClient()
    let calls = 0
    const gate = deferred<void>()
    const createClient = async (): Promise<MCPClient> => {
      calls++
      if (calls === 1) {
        await gate.promise
        return initial
      }
      return refreshed
    }

    const { result } = renderProvider(createClient)

    await act(async () => {
      const pending = result.current.addServer(server)
      // Same url + type, simulating a credential-only edit during the connect window.
      const reconciled = result.current.updateServer({ ...server }, { forceRedial: true })
      gate.resolve()
      await pending
      await reconciled
    })

    expect(calls).toBe(2)
    expect(initial.closeCount()).toBe(1)
    const after = result.current.servers.find((s) => s.id === server.id)
    expect(after?.client).toBe(refreshed as unknown as ProviderMCPClient)
  })

  // Without `forceRedial`, the in-flight guard keeps its original contract:
  // a redundant updateServer during the connect window collapses to one
  // createClient call (useMcpSync's row-diff path relies on this).
  it('skips redial without forceRedial when url/type match an in-flight connect', async () => {
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
      const pending = result.current.addServer(server)
      // No forceRedial → in-flight guard returns early.
      result.current.updateServer({ ...server })
      gate.resolve()
      await pending
    })

    expect(created).toHaveLength(1)
  })

  it('is a no-op when updateServer targets an unknown id', () => {
    const createClient = async (): Promise<MCPClient> => fakeClient()
    const { result } = renderProvider(createClient)

    // No throw, no spurious entry inserted.
    act(() => result.current.updateServer({ ...server, id: 'unknown' }))
    expect(result.current.servers.some((s) => s.id === 'unknown')).toBe(false)
  })
})

// `resolveMcpAccessToken` is the per-connect credential→token resolution that
// `defaultCreateClient` feeds into `buildMcpHeaders`. The reconnect suite above
// injects `createClient` and so never exercises it; this asserts the OAuth
// branch directly (the THU-573 bearer + no-auth paths must stay intact).
describe('resolveMcpAccessToken', () => {
  const cloudUrl = 'http://localhost:8000/v1'

  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  it('injects the freshly refreshed token for an oauth credential', async () => {
    const serverId = 'oauth-srv'
    await setMcpServerCredentials(getDb(), serverId, {
      type: 'oauth',
      access_token: 'stale-token',
      refresh_token: 'r1',
      expires_at: Date.now() - 1_000,
      issuer: 'https://auth.example.com',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
    })

    // Fake ensure-valid stands in for the SDK refresh path: it returns the
    // rotated access token the provider must inject. No real fetch/network.
    let seenServerId: string | undefined
    let seenFetch: FetchLike | undefined
    const ensureValidToken: typeof ensureValidMcpOAuthToken = async (_db, id, fetchFn) => {
      seenServerId = id
      seenFetch = fetchFn
      return 'refreshed-token'
    }

    const credentials = { type: 'oauth' as const, access_token: 'stale-token' }
    const token = await resolveMcpAccessToken(getDb(), serverId, credentials, cloudUrl, ensureValidToken)

    expect(token).toBe('refreshed-token')
    expect(seenServerId).toBe(serverId)
    // The proxy-routed fetch is threaded through to the refresh path.
    expect(typeof seenFetch).toBe('function')
  })

  it('returns the static token verbatim for a bearer credential without touching oauth refresh', async () => {
    let refreshCalled = false
    const ensureValidToken: typeof ensureValidMcpOAuthToken = async () => {
      refreshCalled = true
      return 'should-not-be-used'
    }

    const token = await resolveMcpAccessToken(
      getDb(),
      'bearer-srv',
      { type: 'bearer', token: 'static-bearer' },
      cloudUrl,
      ensureValidToken,
    )

    expect(token).toBe('static-bearer')
    expect(refreshCalled).toBe(false)
  })

  it('returns undefined when the server has no stored credentials', async () => {
    const token = await resolveMcpAccessToken(getDb(), 'no-auth-srv', null, cloudUrl)
    expect(token).toBeUndefined()
  })
})
