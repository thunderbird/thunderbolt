/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The routing seam: how a placement decision turns into one wire target.
 *
 * The properties that matter are the ones a wrong implementation would break
 * silently. A runner-placed turn must reach a synthetic target that the user
 * could never select (and which must never be written back as the thread's
 * agent), while the session's `selectedAgent` stays the built-in agent. The
 * first turn may safely fall back to this device if the runner cannot be
 * reached — but once the runner holds a session id, a failure must surface,
 * because re-prompting could repeat side effects the runner already performed.
 */

import { runnerWireAgentId } from '@/acp/runner-target'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createMockChatInstance, createMockChatThread, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import type { AgentAdapter, AgentAdapterContext } from '@/types/acp'
import type { Agent } from '@/types/acp'
import type { BuiltInPlacementDecision, BuiltInPlacementRequest } from '@/acp/built-in-placement'
import type { RunSpec } from '@shared/acp-types'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatStore } from './chat-store'
import { createAgentRoutingFetch } from './chat-instance'

const sessionId = 'thread-1'
const httpClient: HttpClient = {} as HttpClient
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn
const runnerWsUrl = 'wss://runner.test/ws'
const runSpec: RunSpec = { modelId: 'thunderbolt/opus-mini', thinkingLevel: 'high' }

const runnerDecision: BuiltInPlacementDecision = { placement: 'runner', reason: 'eligible' }
const localDecision: BuiltInPlacementDecision = { placement: 'local', reason: 'no-runner-configured' }

type HarnessOptions = {
  decisions?: BuiltInPlacementDecision[]
  /** Fail the connect for this target id (models a runner outage). */
  failTargetId?: string
  /** Persist a session id from inside the runner send, pinning the thread. */
  pinDuringSend?: boolean
  thread?: Parameters<typeof createMockChatThread>[0] | null
}

const buildHarness = ({ decisions = [runnerDecision], failTargetId, pinDuringSend, thread }: HarnessOptions = {}) => {
  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: thread ? createMockChatThread(thread) : null,
    id: sessionId,
    selectedModel: { id: 'm1', model: 'thunderbolt/opus-mini', provider: 'thunderbolt', isConfidential: 0 } as never,
    triggerData: null,
  })
  useChatStore.getState().updateSession(sessionId, { selectedAgent: builtInAgent })

  const contexts: AgentAdapterContext[] = []
  const targets: Agent[] = []
  const persisted: string[] = []

  const getOrConnectAdapter = mock(async (target: Agent): Promise<AgentAdapter> => {
    targets.push(target)
    if (target.id === failTargetId) {
      throw new Error('transport down')
    }
    return {
      agent: target,
      capabilities: null,
      fetch: async (_init: RequestInit, context: AgentAdapterContext) => {
        contexts.push(context)
        if (pinDuringSend && target.id === runnerWireAgentId) {
          await context.onAcpSessionId('sess-runner-1')
        }
        return new Response(target.id)
      },
      ensureSession: async () => {},
      disconnect: () => {},
    }
  })

  const remaining = [...decisions]
  const decideBuiltInPlacement = mock(
    async (_request: BuiltInPlacementRequest) => remaining.shift() ?? decisions[decisions.length - 1],
  )
  const announceCloudExecution = mock(() => {})
  const updateChatThread = mock(async (_db: unknown, _id: string, patch: { acpSessionId?: string }) => {
    if (patch.acpSessionId) {
      persisted.push(patch.acpSessionId)
    }
  })

  const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
    getOrConnectAdapter: getOrConnectAdapter as never,
    updateChatThread: updateChatThread as never,
    getDb: (() => ({})) as never,
    getRunnerWsUrl: () => runnerWsUrl,
    resolveRunSpec: (async () => runSpec) as never,
    decideBuiltInPlacement: decideBuiltInPlacement as never,
    announceCloudExecution,
  })

  return { announceCloudExecution, contexts, decideBuiltInPlacement, fetch, persisted, targets }
}

const send = (fetch: ReturnType<typeof buildHarness>['fetch'], text = 'hi') =>
  fetch('https://x', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }] }),
  })

describe('createAgentRoutingFetch — placement routing', () => {
  beforeEach(resetStore)
  afterEach(resetStore)

  it('sends a runner-placed turn to the synthetic wire target with a run spec', async () => {
    const { contexts, fetch, targets } = buildHarness()

    await send(fetch)

    expect(targets.map((t) => t.id)).toEqual([runnerWireAgentId])
    expect(targets[0].url).toBe(runnerWsUrl)
    expect(contexts[0].runSpec).toEqual(runSpec)
  })

  it('leaves the session’s selected agent as the built-in agent', async () => {
    const { fetch } = buildHarness()

    await send(fetch)

    expect(useChatStore.getState().sessions.get(sessionId)?.selectedAgent.id).toBe(builtInAgent.id)
  })

  it('sends a locally placed turn to the built-in agent with no run spec', async () => {
    const { contexts, fetch, targets } = buildHarness({ decisions: [localDecision] })

    await send(fetch)

    expect(targets.map((t) => t.id)).toEqual([builtInAgent.id])
    expect(contexts[0].runSpec).toBeUndefined()
  })

  it('keeps the local and runner cache slots separate', async () => {
    const { fetch, targets } = buildHarness({ decisions: [localDecision, runnerDecision] })

    await send(fetch)
    await send(fetch)

    expect(targets.map((t) => t.id)).toEqual([builtInAgent.id, runnerWireAgentId])
  })

  it('discloses cloud execution once, on the first runner-placed send', async () => {
    const { announceCloudExecution, fetch } = buildHarness({ decisions: [runnerDecision, runnerDecision] })

    await send(fetch)
    await send(fetch)

    // The store behind the notice owns the seen-once flag; the routing seam's
    // job is to announce every runner placement rather than guess at it.
    expect(announceCloudExecution).toHaveBeenCalledTimes(2)
  })

  it('does not disclose cloud execution for a local send', async () => {
    const { announceCloudExecution, fetch } = buildHarness({ decisions: [localDecision] })

    await send(fetch)

    expect(announceCloudExecution).not.toHaveBeenCalled()
  })

  it('persists the runner session id, pinning the thread for later sends', async () => {
    const { fetch, persisted } = buildHarness({ pinDuringSend: true })

    await send(fetch)

    expect(persisted).toEqual(['sess-runner-1'])
  })

  it('treats a pin taken this send as runner-owned even before sync reads it back', async () => {
    const { decideBuiltInPlacement, fetch } = buildHarness({
      decisions: [runnerDecision, runnerDecision],
      pinDuringSend: true,
    })

    await send(fetch)
    await send(fetch)

    // The thread snapshot in the store is still the pre-pin one, so only the
    // remembered placement can carry `isRunnerOwned` into the second decision.
    expect(decideBuiltInPlacement.mock.calls[1]?.[0]).toMatchObject({ isRunnerOwned: true })
  })

  it('falls back to this device when the runner cannot be reached on the first turn', async () => {
    const { fetch, targets } = buildHarness({ failTargetId: runnerWireAgentId })

    const response = await send(fetch)

    expect(await response.text()).toBe(builtInAgent.id)
    expect(targets.map((t) => t.id)).toEqual([runnerWireAgentId, builtInAgent.id])
  })

  it('does not disclose cloud execution for a turn that fell back', async () => {
    const { announceCloudExecution, fetch } = buildHarness({ failTargetId: runnerWireAgentId })

    await send(fetch)

    expect(announceCloudExecution).not.toHaveBeenCalled()
  })

  it('surfaces the failure instead of rerouting once the runner owns the session', async () => {
    const { fetch, targets } = buildHarness({
      decisions: [{ placement: 'runner', reason: 'runner-owned' }],
      failTargetId: runnerWireAgentId,
      thread: { acpSessionId: 'sess-runner-1' },
    })

    await expect(send(fetch)).rejects.toThrow('transport down')
    expect(targets.map((t) => t.id)).toEqual([runnerWireAgentId])
  })

  it('fails a refused send loudly rather than running it in the wrong place', async () => {
    const { fetch, targets } = buildHarness({
      decisions: [{ placement: 'refuse', reason: 'runner-owned-needs-attachments' }],
      thread: { acpSessionId: 'sess-runner-1' },
    })

    await expect(send(fetch)).rejects.toThrow('cannot read files from this device')
    expect(targets).toHaveLength(0)
  })

  it('reports prior turns and thread state to the decision', async () => {
    const { decideBuiltInPlacement, fetch } = buildHarness({
      decisions: [localDecision],
      thread: { acpSessionId: null, isEncrypted: 1 },
    })

    await fetch('https://x', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second' }] },
        ],
      }),
    })

    expect(decideBuiltInPlacement.mock.calls[0]?.[0]).toMatchObject({
      agent: builtInAgent,
      isRunnerOwned: false,
      isEncryptedThread: true,
      hasPriorTurns: true,
      hasAttachments: false,
      runnerWsUrl,
    })
  })
})
