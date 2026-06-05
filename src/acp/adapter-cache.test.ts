/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `adapter-cache` tests. The cache is module-global, so each test forgets prior
 * entries via `clearAdapterCache` first. `connectToAgent` is injected as a
 * counting fake (no `mock.module`, no network) so we can assert the cache opens
 * exactly one connection per agent and reuses it across threads/sessions.
 */

import '@/testing-library'

import { beforeEach, describe, expect, it } from 'bun:test'
import type { ConnectToAgentContext } from './connect'
import type { Agent, AgentAdapter } from '@/types/acp'
import { clearAdapterCache, disposeAdapter, disposeAllAdapters, getOrConnectAdapter } from './adapter-cache'

const agentA: Agent = {
  id: 'agent-a',
  name: 'A',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://a.test/ws',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'u1',
}

const agentB: Agent = { ...agentA, id: 'agent-b', url: 'wss://b.test/ws' }

const ctx: ConnectToAgentContext = {
  httpClient: {} as ConnectToAgentContext['httpClient'],
  getProxyFetch: () => (async () => new Response('ok')) as never,
}

/** Build a fake adapter for `agent` that tracks disconnect calls. */
const buildAdapter = (agent: Agent) => {
  let disconnects = 0
  const adapter: AgentAdapter = {
    agent,
    capabilities: null,
    fetch: async () => new Response('ok'),
    disconnect: () => {
      disconnects++
    },
  }
  return { adapter, disconnectCount: () => disconnects }
}

/** A counting fake `connectToAgent`. `delayMs` lets a test hold the connect
 *  in-flight to exercise concurrent dedupe; `fail` exercises eviction. */
const makeCounter = (
  resolveFor: (agent: Agent) => AgentAdapter,
  opts: { fail?: boolean; resolver?: { release: () => void; gate: Promise<void> } } = {},
) => {
  let calls = 0
  const connectToAgent = (async (agent: Agent) => {
    calls++
    if (opts.resolver) {
      await opts.resolver.gate
    }
    if (opts.fail) {
      throw new Error('connect failed')
    }
    return resolveFor(agent)
  }) as never
  return { connectToAgent, callCount: () => calls }
}

describe('adapter-cache', () => {
  beforeEach(() => {
    clearAdapterCache()
  })

  it('reuses ONE adapter for the same agentId across two different sessionIds (connect once)', async () => {
    const { adapter } = buildAdapter(agentA)
    const { connectToAgent, callCount } = makeCounter(() => adapter)

    // Two distinct "threads/sessions" route to the same agent.
    const first = await getOrConnectAdapter(agentA, ctx, { connectToAgent })
    const second = await getOrConnectAdapter(agentA, ctx, { connectToAgent })

    expect(first).toBe(adapter)
    expect(second).toBe(adapter)
    expect(callCount()).toBe(1)
  })

  it('opens separate connections for different agents', async () => {
    const a = buildAdapter(agentA)
    const b = buildAdapter(agentB)
    const { connectToAgent, callCount } = makeCounter((agent) => (agent.id === agentA.id ? a.adapter : b.adapter))

    const ra = await getOrConnectAdapter(agentA, ctx, { connectToAgent })
    const rb = await getOrConnectAdapter(agentB, ctx, { connectToAgent })

    expect(ra).toBe(a.adapter)
    expect(rb).toBe(b.adapter)
    expect(callCount()).toBe(2)
  })

  it('dedupes concurrent first-use to a single connect', async () => {
    const { adapter } = buildAdapter(agentA)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { connectToAgent, callCount } = makeCounter(() => adapter, { resolver: { release, gate } })

    // Fire both before the connect resolves.
    const p1 = getOrConnectAdapter(agentA, ctx, { connectToAgent })
    const p2 = getOrConnectAdapter(agentA, ctx, { connectToAgent })
    release()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toBe(adapter)
    expect(r2).toBe(adapter)
    expect(callCount()).toBe(1)
  })

  it('disposeAdapter evicts and disconnects', async () => {
    const { adapter, disconnectCount } = buildAdapter(agentA)
    const { connectToAgent, callCount } = makeCounter(() => adapter)

    await getOrConnectAdapter(agentA, ctx, { connectToAgent })
    await disposeAdapter(agentA.id)

    expect(disconnectCount()).toBe(1)

    // Evicted → the next use reconnects.
    await getOrConnectAdapter(agentA, ctx, { connectToAgent })
    expect(callCount()).toBe(2)
  })

  it('disposeAdapter is a no-op for an agent with no cached connection', async () => {
    await expect(disposeAdapter('never-connected')).resolves.toBeUndefined()
  })

  it('evicts a failed connect so the next call retries', async () => {
    const { adapter } = buildAdapter(agentA)
    const failing = makeCounter(() => adapter, { fail: true })

    await expect(getOrConnectAdapter(agentA, ctx, { connectToAgent: failing.connectToAgent })).rejects.toThrow(
      'connect failed',
    )
    expect(failing.callCount()).toBe(1)

    // The poisoned entry was evicted — a retry connects again (and succeeds).
    const succeeding = makeCounter(() => adapter)
    const result = await getOrConnectAdapter(agentA, ctx, { connectToAgent: succeeding.connectToAgent })
    expect(result).toBe(adapter)
    expect(succeeding.callCount()).toBe(1)
  })

  it('disposeAllAdapters disconnects every cached adapter and clears', async () => {
    const a = buildAdapter(agentA)
    const b = buildAdapter(agentB)
    const { connectToAgent, callCount } = makeCounter((agent) => (agent.id === agentA.id ? a.adapter : b.adapter))

    await getOrConnectAdapter(agentA, ctx, { connectToAgent })
    await getOrConnectAdapter(agentB, ctx, { connectToAgent })

    await disposeAllAdapters()

    expect(a.disconnectCount()).toBe(1)
    expect(b.disconnectCount()).toBe(1)

    // Cleared → reconnect on next use.
    await getOrConnectAdapter(agentA, ctx, { connectToAgent })
    expect(callCount()).toBe(3)
  })
})
