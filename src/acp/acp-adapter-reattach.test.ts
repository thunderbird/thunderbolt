/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `adapter.reattach` + `adapter.deleteRunnerSession` — the runner detached-turn
 * surface (`shared/acp-types.ts`).
 *
 * Reattach is a catch-up, not a prompt: it must produce a stream ONLY when
 * there is genuinely something to replay, and stay a silent `null` otherwise
 * (the chat layer turns that into a 204). The interesting ordering detail is
 * that the runner writes the replayed `session/update`s BEFORE the replay
 * method's response, so the sink has to be registered first — the happy-path
 * test drives notifications in exactly that order.
 *
 * Everything is injected: a `FakeConnection` stands in for the ACP SDK's
 * `ClientSideConnection` and a fake transport supplies the streams, so no
 * network or timers of our own. Fake timers are global — advanced via
 * `getClock()` inside `act`.
 */

import '@/testing-library'

import { act } from '@testing-library/react'
import type {
  Agent as AcpSdkAgent,
  Client,
  InitializeRequest,
  NewSessionRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import {
  detachedTurnsCapabilityMeta,
  runnerAwaitTurnMethod,
  runnerDeleteSessionMethod,
  runnerReplayMethod,
  type RunnerReplayResponse,
  type RunnerTurnRecord,
} from '@shared/acp-types'
import type { AcpTransport } from './types'
import { connectAcpAdapter, type AcpAdapterContext } from './acp-adapter'

const runnerTarget: Agent = {
  id: '__thunderbolt-runner__',
  name: 'Thunderbolt',
  type: 'managed-acp',
  transport: 'websocket',
  url: 'wss://runner.test/ws',
  description: null,
  icon: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

const baseCtx = (): AcpAdapterContext => ({ httpClient: {} as AcpAdapterContext['httpClient'] })

const threadCtx = (threadId: string, overrides: Partial<AgentAdapterContext> = {}): AgentAdapterContext =>
  ({
    threadId,
    acpSessionId: null,
    onAcpSessionId: async () => {},
    ...overrides,
  }) as AgentAdapterContext

const buildFakeTransport = (): AcpTransport => {
  const closed = new Promise<void>(() => {})
  return {
    stream: { readable: new ReadableStream(), writable: new WritableStream() },
    close: () => {},
    closed,
  }
}

const finishedTurn = (overrides: Partial<RunnerTurnRecord> = {}): RunnerTurnRecord => ({
  startSeq: 1,
  endSeq: 4,
  stopReason: 'end_turn',
  errorMessage: null,
  ...overrides,
})

type FakeConnectionOptions = {
  detachedTurns?: boolean
  resume?: boolean
  /** Reject `session/resume` so resolution falls through to a fresh session. */
  rejectResume?: boolean
  /** Replay response, or `null`/`'reject'` to model a runner with nothing to replay. */
  replay?: RunnerReplayResponse | null | 'reject'
  awaitTurn?: RunnerTurnRecord | null | 'reject'
  /** Notifications the runner writes ahead of the replay response. */
  replayNotifications?: SessionNotification[]
  rejectDelete?: boolean
}

const buildFakeConnection = (opts: FakeConnectionOptions = {}) => {
  const calls = {
    initialize: [] as InitializeRequest[],
    newSession: [] as NewSessionRequest[],
    resumeSession: [] as ResumeSessionRequest[],
    extMethod: [] as { method: string; params: unknown }[],
  }
  let client: Client | null = null
  let newSessionCount = 0

  class FakeConnection {
    constructor(toClient: (agent: AcpSdkAgent) => Client, _stream: AcpTransport['stream']) {
      client = toClient({} as AcpSdkAgent)
    }
    initialize = (req: InitializeRequest) => {
      calls.initialize.push(req)
      return Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: opts.resume ? { resume: {} } : {},
          _meta: opts.detachedTurns ? detachedTurnsCapabilityMeta : undefined,
        },
      })
    }
    newSession = (req: NewSessionRequest) => {
      calls.newSession.push(req)
      newSessionCount++
      return Promise.resolve({ sessionId: `sess-${newSessionCount}` })
    }
    resumeSession = (req: ResumeSessionRequest) => {
      calls.resumeSession.push(req)
      return opts.rejectResume ? Promise.reject(new Error('session evicted')) : Promise.resolve({})
    }
    extMethod = async (method: string, params: unknown) => {
      calls.extMethod.push({ method, params })
      if (method === runnerReplayMethod) {
        // The runner writes the journaled updates through the same connection
        // before answering, so push them first.
        for (const notification of opts.replayNotifications ?? []) {
          await client?.sessionUpdate(notification)
        }
        if (opts.replay === 'reject') {
          throw new Error('replay unavailable')
        }
        return opts.replay ?? null
      }
      if (method === runnerAwaitTurnMethod) {
        if (opts.awaitTurn === 'reject') {
          throw new Error('await failed')
        }
        return { turn: opts.awaitTurn ?? null }
      }
      if (method === runnerDeleteSessionMethod) {
        if (opts.rejectDelete) {
          throw new Error('delete refused')
        }
        return {}
      }
      throw new Error(`unexpected ext method ${method}`)
    }
  }

  return {
    FakeConnection,
    calls,
    pushUpdate: (n: SessionNotification) => client?.sessionUpdate(n),
    pushPermission: (req: RequestPermissionRequest): Promise<RequestPermissionResponse> | undefined =>
      client?.requestPermission(req),
  }
}

const textNotification = (sessionId: string, text: string): SessionNotification => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
})

const readSse = async (response: Response, max = 50): Promise<string> => {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  for (let i = 0; i < max; i++) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    chunks.push(decoder.decode(value))
  }
  reader.releaseLock()
  return chunks.join('')
}

const connect = async (opts: FakeConnectionOptions) => {
  const fake = buildFakeConnection(opts)
  const adapter = await connectAcpAdapter(runnerTarget, baseCtx(), {
    openTransport: async () => buildFakeTransport(),
    ClientSideConnection: fake.FakeConnection as never,
    textDeltaThrottleMs: 0,
  })
  return { adapter, ...fake }
}

describe('connectAcpAdapter — reattach', () => {
  it('resolves null without touching the wire when the agent lacks detachedTurns', async () => {
    const { adapter, calls } = await connect({ detachedTurns: false, resume: true })

    expect(await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))).toBeNull()
    expect(calls.extMethod).toHaveLength(0)
    // Not even a session resolution — there is nothing this agent could replay.
    expect(calls.resumeSession).toHaveLength(0)
  })

  it('resolves null when the thread has no stored session', async () => {
    const { adapter, calls } = await connect({ detachedTurns: true, resume: true })

    expect(await adapter.reattach!(threadCtx('t1'))).toBeNull()
    expect(calls.extMethod).toHaveLength(0)
  })

  it('resolves null when resolution mints a fresh session instead of restoring the stored one', async () => {
    const { adapter, calls } = await connect({ detachedTurns: true, resume: true, rejectResume: true })

    expect(await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))).toBeNull()
    // A fresh session has no turn to catch up on, so replay is never asked for.
    expect(calls.newSession).toHaveLength(1)
    expect(calls.extMethod).toHaveLength(0)
  })

  it('resolves null when the runner has no turn to replay', async () => {
    const { adapter, calls } = await connect({
      detachedTurns: true,
      resume: true,
      replay: { turnActive: false, turn: null },
    })

    expect(await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))).toBeNull()
    expect(calls.extMethod.map((c) => c.method)).toEqual([runnerReplayMethod])
  })

  it('resolves null when the replay call itself fails', async () => {
    const { adapter } = await connect({ detachedTurns: true, resume: true, replay: 'reject' })

    expect(await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))).toBeNull()
  })

  it('streams notifications that arrived before the replay response and stamps the replaced message id', async () => {
    const { adapter, calls } = await connect({
      detachedTurns: true,
      resume: true,
      replay: { turnActive: false, turn: finishedTurn() },
      replayNotifications: [textNotification('sess-stored', 'replayed '), textNotification('sess-stored', 'text')],
    })

    const response = await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }), 'msg-partial-1')
    expect(response?.headers.get('content-type')).toBe('text/event-stream')

    let sse = ''
    await act(async () => {
      await getClock().runAllAsync()
      sse = await readSse(response!)
    })

    expect(sse).toContain('replayed ')
    expect(sse).toContain('text')
    // The replayed turn must land on the existing partial's id so it replaces
    // that message rather than appending a duplicate.
    expect(sse).toContain('"messageId":"msg-partial-1"')
    expect(sse).toContain('[DONE]')
    expect(calls.extMethod.map((c) => c.method)).toEqual([runnerReplayMethod])
  })

  it('omits the message id when no partial is being replaced', async () => {
    const { adapter } = await connect({
      detachedTurns: true,
      resume: true,
      replay: { turnActive: false, turn: finishedTurn() },
      replayNotifications: [textNotification('sess-stored', 'hello')],
    })

    const response = await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))
    let sse = ''
    await act(async () => {
      await getClock().runAllAsync()
      sse = await readSse(response!)
    })

    expect(sse).toContain('hello')
    expect(sse).not.toContain('"messageId"')
  })

  it('awaits a still-running turn and surfaces its failure as a non-retryable error', async () => {
    const { adapter, calls } = await connect({
      detachedTurns: true,
      resume: true,
      replay: { turnActive: true, turn: finishedTurn({ endSeq: null, stopReason: null }) },
      awaitTurn: finishedTurn({ stopReason: null, errorMessage: 'model overloaded' }),
    })

    const response = await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))
    let sse = ''
    await act(async () => {
      await getClock().runAllAsync()
      sse = await readSse(response!)
    })

    expect(calls.extMethod.map((c) => c.method)).toEqual([runnerReplayMethod, runnerAwaitTurnMethod])
    expect(sse).toContain('model overloaded')
    // The failure already happened while we were away — auto-resubmitting a
    // tool-executing agent's prompt on thread-open would be surprising.
    expect(sse).toContain('\\"isRetryable\\":false')
  })

  it('surfaces an awaitTurn transport failure as a stream error', async () => {
    const { adapter } = await connect({
      detachedTurns: true,
      resume: true,
      replay: { turnActive: true, turn: finishedTurn({ endSeq: null }) },
      awaitTurn: 'reject',
    })

    const response = await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))
    let sse = ''
    await act(async () => {
      await getClock().runAllAsync()
      sse = await readSse(response!)
    })

    expect(sse).toContain('await failed')
  })

  it('tears down the session sinks when the turn resolves', async () => {
    const { adapter, pushUpdate, pushPermission } = await connect({
      detachedTurns: true,
      resume: true,
      replay: { turnActive: false, turn: finishedTurn() },
      replayNotifications: [textNotification('sess-stored', 'done')],
    })

    const response = await adapter.reattach!(
      threadCtx('t1', {
        acpSessionId: 'sess-stored',
        requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
      }),
    )
    await act(async () => {
      await getClock().runAllAsync()
      await readSse(response!)
    })

    // Both maps were cleaned: a late notification has nowhere to go (no throw)
    // and a late permission prompt falls back to the adapter's `cancelled`.
    await pushUpdate(textNotification('sess-stored', 'late'))
    const outcome = await pushPermission({
      sessionId: 'sess-stored',
      toolCall: { toolCallId: 'tc-1', title: 'Write file', kind: 'edit' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    } as RequestPermissionRequest)
    expect(outcome?.outcome.outcome).toBe('cancelled')
  })

  it('resolves null after the adapter generation is disconnected', async () => {
    const { adapter, calls } = await connect({
      detachedTurns: true,
      resume: true,
      replay: { turnActive: false, turn: finishedTurn() },
    })

    adapter.disconnect()

    expect(await adapter.reattach!(threadCtx('t1', { acpSessionId: 'sess-stored' }))).toBeNull()
    expect(calls.extMethod).toHaveLength(0)
  })
})

describe('connectAcpAdapter — deleteRunnerSession', () => {
  it('stays silent when the agent does not advertise detachedTurns', async () => {
    const { adapter, calls } = await connect({ detachedTurns: false })

    await adapter.deleteRunnerSession!('sess-doomed')

    expect(calls.extMethod).toHaveLength(0)
  })

  it('sends the delete ext method for the given session without resolving one', async () => {
    const { adapter, calls } = await connect({ detachedTurns: true, resume: true })

    await adapter.deleteRunnerSession!('sess-doomed')

    expect(calls.extMethod).toEqual([{ method: runnerDeleteSessionMethod, params: { sessionId: 'sess-doomed' } }])
    // The session is being destroyed — restoring or minting one would be backwards.
    expect(calls.resumeSession).toHaveLength(0)
    expect(calls.newSession).toHaveLength(0)
  })

  it('rejects when the runner refuses, so callers can decide whether to care', async () => {
    const { adapter } = await connect({ detachedTurns: true, rejectDelete: true })

    await expect(adapter.deleteRunnerSession!('sess-doomed')).rejects.toThrow('delete refused')
  })

  it('rejects after the adapter generation dies', async () => {
    const { adapter } = await connect({ detachedTurns: true })
    adapter.disconnect()

    await expect(adapter.deleteRunnerSession!('sess-doomed')).rejects.toThrow('connection-lost')
  })
})
