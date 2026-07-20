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
  CancelNotification,
  Client,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import type { AcpTransport } from './types'
import { connectAcpAdapter, type AcpAdapterContext } from './acp-adapter'
import type { AcpCommand } from './translators/acp-to-ai-sdk'

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
const buildFakeConnection = (
  opts: {
    hangInitialize?: boolean
    loadSession?: boolean
    resume?: boolean
    /** Reject the resume/load call so a test exercises the tier fallthrough. */
    rejectResume?: boolean
    rejectLoad?: boolean
    /** Reject the fire-and-forget cancel so a test exercises the abort `.catch`. */
    rejectCancel?: boolean
  } = {},
) => {
  const calls = {
    initialize: [] as InitializeRequest[],
    newSession: [] as NewSessionRequest[],
    loadSession: [] as LoadSessionRequest[],
    resumeSession: [] as ResumeSessionRequest[],
    prompt: [] as PromptRequest[],
    cancel: [] as CancelNotification[],
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
      return Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: opts.loadSession ?? false,
          sessionCapabilities: opts.resume ? { resume: {} } : {},
        },
      })
    }
    newSession = (req: NewSessionRequest) => {
      calls.newSession.push(req)
      newSessionCount++
      return Promise.resolve({ sessionId: `sess-${newSessionCount}` })
    }
    loadSession = (req: LoadSessionRequest) => {
      calls.loadSession.push(req)
      return opts.rejectLoad ? Promise.reject(new Error('session unloadable')) : Promise.resolve({})
    }
    resumeSession = (req: ResumeSessionRequest) => {
      calls.resumeSession.push(req)
      return opts.rejectResume ? Promise.reject(new Error('session evicted')) : Promise.resolve({})
    }
    prompt = async (req: PromptRequest) => {
      calls.prompt.push(req)
      await promptGatePromise
      return { stopReason: 'end_turn' as const }
    }
    cancel = (req: CancelNotification) => {
      calls.cancel.push(req)
      return opts.rejectCancel ? Promise.reject(new Error('transport closing')) : Promise.resolve()
    }
  }

  return {
    FakeConnection,
    calls,
    pushUpdate: (n: SessionNotification) => client?.sessionUpdate(n),
    // Route a permission request through the same client the adapter registers,
    // so a test can observe whether a thread's handler is still wired (its own
    // outcome) or has been torn down (the adapter's `cancelled` fallback).
    pushPermission: (req: RequestPermissionRequest): Promise<RequestPermissionResponse> | undefined =>
      client?.requestPermission(req),
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

const promptInit = (text: string, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({ id: 't', messages: [{ role: 'user', parts: [{ type: 'text', text }] }] }),
  signal,
})

/** Build a request body from an explicit turn list so a test can supply prior
 *  history (everything before the trailing user turn) for the fallback replay. */
const conversationInit = (turns: { role: 'user' | 'assistant'; text: string }[]): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({
    id: 't',
    messages: turns.map((t) => ({ role: t.role, parts: [{ type: 'text', text: t.text }] })),
  }),
})

/** Read the text of the single text block the adapter posted on `session/prompt`. */
const sentPromptText = (calls: { prompt: PromptRequest[] }, index = 0): string =>
  (calls.prompt[index]?.prompt?.[0] as { type: string; text: string }).text

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
    expect(calls.newSession[0]?.cwd).toBe('.')

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

  it('folds resolved skill instructions into the prompt ahead of the user text', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const response = await adapter.fetch(
      promptInit('/tell-a-joke'),
      threadCtx('t1', { skillInstructions: ['Tell a joke about cats, then give a time and place to tell it.'] }),
    )
    await act(async () => {
      releasePrompts()
      await getClock().runAllAsync()
      await readSse(response)
    })

    const sent = calls.prompt[0]?.prompt?.[0] as { type: string; text: string }
    expect(sent.text).toBe('Tell a joke about cats, then give a time and place to tell it.\n\n/tell-a-joke')
  })

  it('sends the user text unchanged when no skill instructions resolved', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const response = await adapter.fetch(promptInit('just a normal message'), threadCtx('t1'))
    await act(async () => {
      releasePrompts()
      await getClock().runAllAsync()
      await readSse(response)
    })

    const sent = calls.prompt[0]?.prompt?.[0] as { type: string; text: string }
    expect(sent.text).toBe('just a normal message')
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
    expect(calls.loadSession[0]?.cwd).toBe('.')
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

describe('connectAcpAdapter — agent-level command capture', () => {
  it('ensureSession resolves a session without a prompt, then available_commands_update flows to onAvailableCommands', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, pushUpdate } = buildFakeConnection()

    const captured: AcpCommand[][] = []
    const adapter = await connectAcpAdapter(
      remoteAgent,
      baseCtx({ onAvailableCommands: (commands) => captured.push(commands) }),
      {
        openTransport: async () => transport,
        ClientSideConnection: FakeConnection as never,
      },
    )

    // Warm the thread's session — no prompt is sent.
    await adapter.ensureSession(threadCtx('thread-warm'))
    expect(calls.newSession).toHaveLength(1)
    expect(calls.prompt).toHaveLength(0)

    // The agent advertises its commands on that session, outside any turn.
    await act(async () => {
      pushUpdate({
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'research_codebase', description: 'Explore the codebase', input: { hint: 'topic' } },
            { name: 'create_plan', description: 'Draft a plan' },
          ],
        },
      } as SessionNotification)
      await getClock().runAllAsync()
    })

    expect(captured).toEqual([
      [
        { name: 'research_codebase', description: 'Explore the codebase', inputHint: 'topic' },
        { name: 'create_plan', description: 'Draft a plan', inputHint: undefined },
      ],
    ])
  })

  it('a second ensureSession on the same thread reuses the cached session', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    await adapter.ensureSession(threadCtx('thread-1'))
    await adapter.ensureSession(threadCtx('thread-1'))
    expect(calls.newSession).toHaveLength(1)
  })
})

describe('connectAcpAdapter — capability-aware continuity (resume / load / new+replay)', () => {
  const drive = async (
    adapter: Awaited<ReturnType<typeof connectAcpAdapter>>,
    init: RequestInit,
    ctx: AgentAdapterContext,
    releasePrompts: () => void,
  ) => {
    const response = await adapter.fetch(init, ctx)
    await act(async () => {
      releasePrompts()
      await getClock().runAllAsync()
      await readSse(response)
    })
  }

  it('starts a new session without trying resume or load when no stored session id exists', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection({ resume: true, loadSession: true })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    await drive(adapter, promptInit('hi'), threadCtx('t-new'), releasePrompts)

    expect(calls.resumeSession).toHaveLength(0)
    expect(calls.loadSession).toHaveLength(0)
    expect(calls.newSession).toHaveLength(1)
  })

  it('tier 1: resume-capable agent with a stored id resumes it — no newSession, no re-persist, no replay', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection({ resume: true })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })
    expect(adapter.capabilities).toMatchObject({ resume: true })

    const persisted: string[] = []
    await drive(
      adapter,
      conversationInit([
        { role: 'user', text: 'earlier q' },
        { role: 'assistant', text: 'earlier a' },
        { role: 'user', text: 'now' },
      ]),
      threadCtx('t-resume', { acpSessionId: 'stored-1', onAcpSessionId: async (s) => void persisted.push(s) }),
      releasePrompts,
    )

    expect(calls.resumeSession).toHaveLength(1)
    expect(calls.resumeSession[0]?.sessionId).toBe('stored-1')
    expect(calls.resumeSession[0]?.cwd).toBe('.')
    expect(calls.newSession).toHaveLength(0)
    expect(persisted).toEqual([]) // reused id, nothing fresh to persist
    // No app-side replay: the live prompt carries only the current user text.
    expect(sentPromptText(calls)).toBe('now')
  })

  it('tier 1→3: resume rejects (session evicted) → newSession + persist + transcript replay', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection({ resume: true, rejectResume: true })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const persisted: string[] = []
    await drive(
      adapter,
      conversationInit([
        { role: 'user', text: 'earlier q' },
        { role: 'assistant', text: 'earlier a' },
        { role: 'user', text: 'now' },
      ]),
      threadCtx('t-evicted', { acpSessionId: 'gone-1', onAcpSessionId: async (s) => void persisted.push(s) }),
      releasePrompts,
    )

    expect(calls.resumeSession).toHaveLength(1)
    expect(calls.newSession).toHaveLength(1)
    expect(persisted).toEqual(['sess-1'])
    const text = sentPromptText(calls)
    expect(text).toContain('Conversation so far:')
    expect(text).toContain('user: earlier q')
    expect(text).toContain('assistant: earlier a')
    expect(text.endsWith('now')).toBe(true)
  })

  it('degrade order: agent advertising BOTH resume and loadSession tries resume first (never loadSession)', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection({ resume: true, loadSession: true })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    await drive(adapter, promptInit('hi'), threadCtx('t-both', { acpSessionId: 'stored-9' }), releasePrompts)

    expect(calls.resumeSession).toHaveLength(1)
    expect(calls.loadSession).toHaveLength(0)
    expect(calls.newSession).toHaveLength(0)
  })

  it('tier 1→2: resume rejects but loadSession succeeds → loadSession, no newSession, no replay', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection({
      resume: true,
      rejectResume: true,
      loadSession: true,
    })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    await drive(
      adapter,
      conversationInit([
        { role: 'user', text: 'earlier' },
        { role: 'assistant', text: 'reply' },
        { role: 'user', text: 'now' },
      ]),
      threadCtx('t-load', { acpSessionId: 'stored-2' }),
      releasePrompts,
    )

    expect(calls.resumeSession).toHaveLength(1)
    expect(calls.loadSession).toHaveLength(1)
    expect(calls.newSession).toHaveLength(0)
    expect(sentPromptText(calls)).toBe('now') // agent replays its own history
  })

  it('tier 2→3: loadSession rejects → newSession + transcript replay', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection({ loadSession: true, rejectLoad: true })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    await drive(
      adapter,
      conversationInit([
        { role: 'user', text: 'earlier' },
        { role: 'assistant', text: 'reply' },
        { role: 'user', text: 'now' },
      ]),
      threadCtx('t-loadfail', { acpSessionId: 'stored-3' }),
      releasePrompts,
    )

    expect(calls.loadSession).toHaveLength(1)
    expect(calls.newSession).toHaveLength(1)
    expect(sentPromptText(calls)).toContain('Conversation so far:')
  })

  it('tier 3 consume-once: existing thread seeds the transcript on the first prompt but NOT the second', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection() // no resume/load

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const persisted: string[] = []
    const ctx = () => threadCtx('t-3', { acpSessionId: 'stale-x', onAcpSessionId: async (s) => void persisted.push(s) })

    await drive(
      adapter,
      conversationInit([
        { role: 'user', text: 'q1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'q2' },
      ]),
      ctx(),
      releasePrompts,
    )
    // Second send: the live session now already contains q1/a1/q2, so re-seeding
    // would double-inject. Guard is keyed on the fresh session's first send only.
    await drive(
      adapter,
      conversationInit([
        { role: 'user', text: 'q1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'q2' },
        { role: 'assistant', text: 'a2' },
        { role: 'user', text: 'q3' },
      ]),
      ctx(),
      releasePrompts,
    )

    expect(calls.newSession).toHaveLength(1) // one fresh session, cached
    expect(persisted).toEqual(['sess-1']) // persisted exactly once
    expect(sentPromptText(calls, 0)).toContain('Conversation so far:')
    expect(sentPromptText(calls, 1)).toBe('q3') // no re-seed on the second send
  })

  it('brand-new thread (no prior turns) never seeds a transcript on either send', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    // First ever prompt on a brand-new thread — no stored id, no prior turns.
    await drive(adapter, conversationInit([{ role: 'user', text: 'hello' }]), threadCtx('t-new'), releasePrompts)
    // Second prompt now carries [hello, hi-back] as "prior", but the live session
    // already has them, so nothing must be seeded.
    await drive(
      adapter,
      conversationInit([
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi back' },
        { role: 'user', text: 'again' },
      ]),
      threadCtx('t-new'),
      releasePrompts,
    )

    expect(sentPromptText(calls, 0)).toBe('hello')
    expect(sentPromptText(calls, 1)).toBe('again')
  })

  it('defers persistence: ensureSession warms a fresh session but does NOT persist until the first real send', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const persisted: string[] = []
    const onAcpSessionId = async (s: string) => void persisted.push(s)

    await adapter.ensureSession(threadCtx('t-warm', { onAcpSessionId }))
    expect(calls.newSession).toHaveLength(1)
    expect(persisted).toEqual([]) // warming must not persist an empty session id

    await drive(adapter, promptInit('first'), threadCtx('t-warm', { onAcpSessionId }), releasePrompts)
    expect(calls.newSession).toHaveLength(1) // reused the warmed session
    expect(persisted).toEqual(['sess-1']) // persisted only on the real send
  })

  it('retries fresh-session persistence and transcript seeding after persistence fails', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })
    const init = conversationInit([
      { role: 'user', text: 'earlier' },
      { role: 'assistant', text: 'reply' },
      { role: 'user', text: 'now' },
    ])
    const persistenceAttempts: string[] = []
    const onAcpSessionId = async (sessionId: string): Promise<void> => {
      persistenceAttempts.push(sessionId)
      if (persistenceAttempts.length === 1) {
        throw new Error('persistence failed')
      }
    }
    const context = threadCtx('t-persist-retry', { onAcpSessionId })

    await expect(adapter.fetch(init, context)).rejects.toThrow('persistence failed')
    await drive(adapter, init, context, releasePrompts)

    expect(calls.newSession).toHaveLength(1)
    expect(persistenceAttempts).toEqual(['sess-1', 'sess-1'])
    expect(calls.prompt).toHaveLength(1)
    expect(sentPromptText(calls)).toContain('Conversation so far:')
  })
})

describe('connectAcpAdapter — Stop cancels the remote ACP turn', () => {
  /** A minimal permission request for the given session. The adapter only keys
   *  off `sessionId` when routing, so the rest is filler. */
  const permissionReq = (sessionId: string): RequestPermissionRequest =>
    ({
      sessionId,
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    }) as RequestPermissionRequest

  it('aborting mid-stream sends session/cancel once and tears down the thread handlers', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, pushPermission, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const controller = new AbortController()
    // A thread-owned permission handler that would auto-allow while connected.
    const requestPermission = async (): Promise<RequestPermissionResponse> => ({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    const response = await adapter.fetch(
      promptInit('do something long', controller.signal),
      threadCtx('thread-A', { requestPermission }),
    )

    // The prompt is in flight (gated open); nothing cancelled yet.
    expect(calls.prompt).toHaveLength(1)
    expect(calls.cancel).toHaveLength(0)

    let sse: string[] = []
    await act(async () => {
      controller.abort()
      // Even though the agent later finishes the (now-cancelled) turn, cancel
      // must have fired exactly once — driven by the abort, not the resolution.
      releasePrompts()
      await getClock().runAllAsync()
      sse = await readSse(response)
    })

    expect(calls.cancel).toHaveLength(1)
    expect(calls.cancel[0]?.sessionId).toBe('sess-1')

    // Teardown ran: the body closed with a terminal finish + [DONE]...
    const joined = sse.join('')
    expect(joined).toContain('"type":"finish"')
    expect(joined).toContain('[DONE]')
    expect(sse).toContain('[CLOSED]')

    // ...and the thread's permission handler was unregistered, so a late
    // permission prompt for that session now hits the `cancelled` fallback.
    const outcome = await pushPermission(permissionReq('sess-1'))
    expect(outcome?.outcome.outcome).toBe('cancelled')
  })

  it('a rejecting cancel is swallowed — abort still tears the thread down cleanly', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, pushPermission, releasePrompts } = buildFakeConnection({ rejectCancel: true })

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const controller = new AbortController()
    const response = await adapter.fetch(promptInit('do something long', controller.signal), threadCtx('thread-A'))

    let sse: string[] = []
    await act(async () => {
      controller.abort()
      releasePrompts()
      await getClock().runAllAsync()
      sse = await readSse(response)
    })

    // Cancel fired and its rejection was swallowed (no unhandled rejection), so
    // teardown still completed: the stream closed and the handler unregistered.
    expect(calls.cancel).toHaveLength(1)
    expect(sse.join('')).toContain('[DONE]')
    const outcome = await pushPermission(permissionReq('sess-1'))
    expect(outcome?.outcome.outcome).toBe('cancelled')
  })

  it('a signal already aborted at fetch time cancels immediately', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const response = await adapter.fetch(promptInit('hi', AbortSignal.abort()), threadCtx('thread-A'))

    // The turn was issued (can't un-send) but immediately cancelled — once.
    expect(calls.prompt).toHaveLength(1)
    expect(calls.cancel).toHaveLength(1)
    expect(calls.cancel[0]?.sessionId).toBe('sess-1')

    await act(async () => {
      releasePrompts()
      await getClock().runAllAsync()
      await readSse(response)
    })

    // The agent resolving the cancelled turn does not double-cancel.
    expect(calls.cancel).toHaveLength(1)
  })

  it('a normal completion never sends session/cancel', async () => {
    const { transport } = buildFakeTransport()
    const { FakeConnection, calls, releasePrompts } = buildFakeConnection()

    const adapter = await connectAcpAdapter(remoteAgent, baseCtx(), {
      openTransport: async () => transport,
      ClientSideConnection: FakeConnection as never,
    })

    const controller = new AbortController()
    const response = await adapter.fetch(promptInit('hi', controller.signal), threadCtx('thread-A'))

    let sse: string[] = []
    await act(async () => {
      releasePrompts()
      await getClock().runAllAsync()
      sse = await readSse(response)
    })

    expect(sse.join('')).toContain('"type":"finish"')
    expect(calls.cancel).toHaveLength(0)
  })
})
