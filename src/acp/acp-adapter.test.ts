/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `connectAcpAdapter` tests cover two concerns:
 *
 *  1. Handshake-failure modes (Task C, preserved): a handshake that never
 *     answers, or a transport that closes terminally mid-handshake, must REJECT
 *     (so the chat's fetch throws and the sidebar spinner clears) instead of
 *     hanging on a pending `initialize`.
 *  2. Per-thread session multiplexing over ONE shared connection: two threads
 *     (two ACP sessionIds) each receive only their own `session/update`
 *     notifications (no cross-thread bleed), and each persists its own
 *     `acpSessionId`.
 *
 * Everything is injected — no network. A `FakeConnection` stands in for the ACP
 * SDK `ClientSideConnection`; a fake `openTransport` returns a stream plus a
 * controllable `closed` promise. Fake timers (global) are advanced via
 * `getClock()` inside `act` to drive the handshake timeout deterministically.
 */

import '@/testing-library'

import { act } from '@testing-library/react'
import type {
  Agent as AcpSdkAgent,
  Client,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { AcpTransport } from './types'
import { connectAcpAdapter, type AcpAdapterContext } from './acp-adapter'

const remoteAgent: Agent = {
  id: 'remote-foo',
  name: 'Foo',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.test/ws',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'u1',
}

const baseCtx = (overrides: Partial<AcpAdapterContext> = {}): AcpAdapterContext => ({
  httpClient: {} as AcpAdapterContext['httpClient'],
  ...overrides,
})

/** Build a per-thread fetch context. `acpSessionId`/`onAcpSessionId` drive the
 *  adapter's per-thread `loadSession`/`newSession` resolution. */
const threadCtx = (threadId: string, overrides: Partial<AgentAdapterContext> = {}): AgentAdapterContext =>
  ({
    threadId,
    acpSessionId: null,
    onAcpSessionId: async () => {},
    ...overrides,
  }) as AgentAdapterContext

/** A fake transport with a controllable `closed` promise so a test can fire a
 *  terminal close on demand. `close` is counted so tests can assert the adapter
 *  tears the transport down on a failed handshake (no leaked socket). */
const buildFakeTransport = (): {
  transport: AcpTransport
  rejectClosed: (err: Error) => void
  closeCalls: () => number
} => {
  let rejectClosed: (err: Error) => void = () => {}
  let closeCount = 0
  const closed = new Promise<void>((_, reject) => {
    rejectClosed = reject
  })
  // Keep the rejection handled even when a test never fires it.
  closed.catch(() => {})
  const transport: AcpTransport = {
    stream: { readable: new ReadableStream(), writable: new WritableStream() },
    close: () => {
      closeCount++
    },
    closed,
  }
  return { transport, rejectClosed, closeCalls: () => closeCount }
}

/** Build a fake `ClientSideConnection`. `initialize` is configurable (resolve
 *  or hang). `newSession` hands out distinct ids per call. The `toClient`
 *  factory is captured so a test can push `session/update` notifications through
 *  the real routing path the adapter wires up. */
const buildFakeConnection = (opts: { hangInitialize?: boolean; loadSession?: boolean } = {}) => {
  const calls = {
    initialize: [] as InitializeRequest[],
    newSession: [] as NewSessionRequest[],
    loadSession: [] as LoadSessionRequest[],
    prompt: [] as PromptRequest[],
  }
  let client: Client | null = null
  let newSessionCount = 0
  // Gate prompt resolution so a test can hold both threads' turns open at once.
  const promptGate = { release: () => {} }
  const promptGatePromise = new Promise<void>((resolve) => {
    promptGate.release = resolve
  })

  class FakeConnection {
    constructor(toClient: (agent: AcpSdkAgent) => Client, _stream: AcpTransport['stream']) {
      client = toClient({} as AcpSdkAgent)
    }
    initialize = (req: InitializeRequest) => {
      calls.initialize.push(req)
      if (opts.hangInitialize) {
        return new Promise<never>(() => {})
      }
      return Promise.resolve({ protocolVersion: 1, agentCapabilities: { loadSession: opts.loadSession ?? false } })
    }
    newSession = (req: NewSessionRequest) => {
      calls.newSession.push(req)
      newSessionCount++
      return Promise.resolve({ sessionId: `sess-${newSessionCount}` })
    }
    loadSession = (req: LoadSessionRequest) => {
      calls.loadSession.push(req)
      return Promise.resolve({})
    }
    prompt = async (req: PromptRequest) => {
      calls.prompt.push(req)
      await promptGatePromise
      return { stopReason: 'end_turn' as const }
    }
  }

  return {
    FakeConnection,
    calls,
    pushUpdate: (n: SessionNotification) => client?.sessionUpdate(n),
    releasePrompts: () => promptGate.release(),
  }
}

/** Observe a connect promise's settlement as a tagged value so assertions
 *  don't rely on `.rejects` (which hangs under fake timers when the promise was
 *  created in a prior tick). */
const observeConnect = (p: Promise<unknown>): Promise<{ rejected: boolean; message?: string }> =>
  p.then(
    () => ({ rejected: false }),
    (err: Error) => ({ rejected: true, message: err.message }),
  )

const readSse = async (response: Response, max = 50): Promise<string[]> => {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  for (let i = 0; i < max; i++) {
    const { value, done } = await reader.read()
    if (done) {
      chunks.push('[CLOSED]')
      break
    }
    chunks.push(decoder.decode(value))
  }
  reader.releaseLock()
  return chunks
}

const promptInit = (text: string): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({ id: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }),
})

describe('connectAcpAdapter — handshake failure modes', () => {
  it('rejects after handshakeTimeoutMs when initialize never resolves and tears down the transport', async () => {
    const { transport, closeCalls } = buildFakeTransport()
    const { FakeConnection } = buildFakeConnection({ hangInitialize: true })

    const observed = observeConnect(
      connectAcpAdapter(remoteAgent, baseCtx(), {
        openTransport: async () => transport,
        ClientSideConnection: FakeConnection as never,
        handshakeTimeoutMs: 5000,
      }),
    )

    await act(async () => {
      await getClock().tickAsync(5000)
    })

    const result = await observed
    expect(result.rejected).toBe(true)
    expect(result.message).toMatch(/handshake timed out after 5000ms/)
    // The silent socket must be closed so it (and its reconnect machinery) can't leak.
    expect(closeCalls()).toBeGreaterThanOrEqual(1)
  })

  it('rejects promptly when the transport closes terminally mid-handshake', async () => {
    const { transport, rejectClosed } = buildFakeTransport()
    const { FakeConnection } = buildFakeConnection({ hangInitialize: true })

    const observed = observeConnect(
      connectAcpAdapter(remoteAgent, baseCtx(), {
        openTransport: async () => transport,
        ClientSideConnection: FakeConnection as never,
        handshakeTimeoutMs: 30_000,
      }),
    )

    rejectClosed(new Error('ACP transport closed (code 4003)'))
    await act(async () => {
      await getClock().tickAsync(1)
    })

    const result = await observed
    expect(result.rejected).toBe(true)
    expect(result.message).toMatch(/code 4003/)
  })

  it('regression: a normal handshake resolves and fetch streams a terminal finish + [DONE]', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
      handshakeTimeoutMs: 30_000,
    })

    // initialize runs at connect; the session is resolved lazily on first fetch.
    expect(calls.initialize).toHaveLength(1)
    expect(calls.newSession).toHaveLength(0)
    expect(adapter.capabilities).toMatchObject({ loadSession: false })

    const response = await adapter.fetch(promptInit('hi'), threadCtx('t1'))
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(calls.newSession).toHaveLength(1)

    let sse: string[] = []
    await act(async () => {
      releasePrompts()
      await getClock().runAllAsync()
      sse = await readSse(response)
    })

    const joined = sse.join('')
    expect(calls.prompt).toHaveLength(1)
    expect(joined).toContain('"type":"finish"')
    expect(joined).toContain('[DONE]')
    // The body must close so the AI SDK leaves the streaming state.
    expect(sse).toContain('[CLOSED]')
  })
})

describe('connectAcpAdapter — per-thread session multiplexing over one connection', () => {
  it('resolves a separate ACP session per thread and persists each independently', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const persistedA: string[] = []
    const persistedB: string[] = []

    await adapter.fetch(
      promptInit('a'),
      threadCtx('thread-A', { onAcpSessionId: async (s) => void persistedA.push(s) }),
    )
    await adapter.fetch(
      promptInit('b'),
      threadCtx('thread-B', { onAcpSessionId: async (s) => void persistedB.push(s) }),
    )

    // One connection, one initialize, but a distinct newSession per thread.
    expect(calls.initialize).toHaveLength(1)
    expect(calls.newSession).toHaveLength(2)
    expect(persistedA).toEqual(['sess-1'])
    expect(persistedB).toEqual(['sess-2'])

    // A second send on thread-A reuses its cached session — no extra newSession.
    await adapter.fetch(promptInit('a2'), threadCtx('thread-A'))
    expect(calls.newSession).toHaveLength(2)
  })

  it('loadSession-capable agent reuses a thread acpSessionId without a newSession', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls } = buildFakeConnection({ loadSession: true })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const persisted: string[] = []
    await adapter.fetch(
      promptInit('hi'),
      threadCtx('thread-X', { acpSessionId: 'prior-sess', onAcpSessionId: async (s) => void persisted.push(s) }),
    )

    expect(calls.loadSession).toHaveLength(1)
    expect(calls.loadSession[0]?.sessionId).toBe('prior-sess')
    expect(calls.newSession).toHaveLength(0)
    // loadSession reuses the existing id — nothing fresh to persist.
    expect(persisted).toEqual([])
  })

  it('routes session/update notifications to the owning thread only — no cross-thread bleed', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, pushUpdate, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    // Two threads stream concurrently — prompts are gated open until released.
    const responseA = await adapter.fetch(promptInit('a'), threadCtx('thread-A'))
    const responseB = await adapter.fetch(promptInit('b'), threadCtx('thread-B'))

    // thread-A → sess-1, thread-B → sess-2.
    expect(calls.newSession).toHaveLength(2)

    let sseA: string[] = []
    let sseB: string[] = []
    await act(async () => {
      // Each notification targets exactly one session id; the other must not see it.
      pushUpdate({
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ALPHA' } },
      } as SessionNotification)
      pushUpdate({
        sessionId: 'sess-2',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BETA' } },
      } as SessionNotification)
      releasePrompts()
      await getClock().runAllAsync()
      sseA = await readSse(responseA)
      sseB = await readSse(responseB)
    })

    const joinedA = sseA.join('')
    const joinedB = sseB.join('')
    expect(joinedA).toContain('ALPHA')
    expect(joinedA).not.toContain('BETA')
    expect(joinedB).toContain('BETA')
    expect(joinedB).not.toContain('ALPHA')
  })
})
