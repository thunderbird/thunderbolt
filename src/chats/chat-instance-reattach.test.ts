/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `createAgentRoutingFetch` GET routing (the AI SDK's `resumeStream()`
 * reconnect) and the encrypted-thread guard on the prompt path.
 *
 * A GET must never reach `adapter.fetch` — it routes to `adapter.reattach`, and
 * every "nothing to catch up on" case has to come back as a 204 the SDK treats
 * as a quiet no-op. The subtle part is the trailing crash-recovery partial: it
 * is lifted out of chat state so the replayed turn replaces it, and must be put
 * back verbatim when nothing gets replayed.
 *
 * Catch-up is keyed on the runner-owned marker — the built-in agent plus a
 * persisted `acpSessionId` — and dials a synthetic runner wire target rather
 * than any agent the user could pick. Adapters are injected, so no transport.
 */

import { runnerWireAgentId } from '@/acp/runner-target'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createMockChatInstance, createMockChatThread, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent, AgentAdapter, ReattachContext } from '@/types/acp'
import type { RunSpec } from '@shared/acp-types'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatStore } from './chat-store'
import { createAgentRoutingFetch } from './chat-instance'

const sessionId = 'sess-1'
const httpClient: HttpClient = {} as HttpClient
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn
const runnerWsUrl = 'wss://runner.test/ws'
const runSpec: RunSpec = { modelId: 'thunderbolt/opus-mini', thinkingLevel: 'medium' }

const customAgent: Agent = {
  id: 'custom-1',
  name: 'My agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://elsewhere.test',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-1',
}

const partialMessage: ThunderboltUIMessage = {
  id: 'msg-partial-1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'half a th' }],
  metadata: { partial: true },
}

type HarnessOptions = {
  agent?: Agent
  thread?: Parameters<typeof createMockChatThread>[0] | null
  messages?: ThunderboltUIMessage[]
  /** Omitted → an adapter with no `reattach` (e.g. the built-in adapter). */
  reattach?: (context: ReattachContext, replaceMessageId?: string) => Promise<Response | null>
  connectFails?: boolean
  wsUrl?: string | null
}

const buildHarness = ({
  agent = builtInAgent,
  thread,
  messages = [],
  reattach,
  connectFails,
  wsUrl = runnerWsUrl,
}: HarnessOptions = {}) => {
  const chatInstance = createMockChatInstance(messages)
  hydrateStore({
    chatInstance,
    chatThread: thread ? createMockChatThread(thread) : null,
    id: sessionId,
    selectedModel: { id: 'm1', model: 'thunderbolt/opus-mini', provider: 'thunderbolt', isConfidential: 0 } as never,
    triggerData: null,
  })
  useChatStore.getState().updateSession(sessionId, { selectedAgent: agent })

  const adapterFetch = mock(async () => new Response('prompt'))
  const reattachSpy = reattach ? mock(reattach) : undefined
  const getOrConnectAdapter = mock(async (connectedAgent: Agent): Promise<AgentAdapter> => {
    if (connectFails) {
      throw new Error('transport down')
    }
    return {
      agent: connectedAgent,
      capabilities: null,
      fetch: adapterFetch,
      ensureSession: async () => {},
      ...(reattachSpy ? { reattach: reattachSpy } : {}),
      disconnect: () => {},
    }
  })

  const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
    getOrConnectAdapter: getOrConnectAdapter as never,
    updateChatThread: (async () => {}) as never,
    getDb: (() => ({})) as never,
    getRunnerWsUrl: () => wsUrl,
    resolveRunSpec: (async () => runSpec) as never,
    decideBuiltInPlacement: (async () => ({ placement: 'local', reason: 'thread-already-local' })) as never,
  })

  return { adapterFetch, chatInstance, fetch, getOrConnectAdapter, reattachSpy }
}

const get = (fetch: ReturnType<typeof buildHarness>['fetch']) => fetch('https://x', { method: 'GET' })

describe('createAgentRoutingFetch — GET catch-up routing', () => {
  beforeEach(resetStore)
  afterEach(resetStore)

  it('never routes a GET to the prompt path', async () => {
    const { adapterFetch, fetch, reattachSpy } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      reattach: async () => new Response('replayed'),
    })

    const response = await get(fetch)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('replayed')
    expect(adapterFetch).not.toHaveBeenCalled()
    expect(reattachSpy).toHaveBeenCalledTimes(1)
  })

  it('dials the synthetic runner wire target, never an agent the user could pick', async () => {
    const { fetch, getOrConnectAdapter } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      reattach: async () => new Response('replayed'),
    })

    await get(fetch)

    const target = getOrConnectAdapter.mock.calls[0]?.[0]
    expect(target?.id).toBe(runnerWireAgentId)
    expect(target?.url).toBe(runnerWsUrl)
  })

  it('returns 204 for another agent’s session — that agent owns its own resume', async () => {
    const { fetch, reattachSpy } = buildHarness({
      agent: customAgent,
      thread: { acpSessionId: 'sess-stored' },
      reattach: async () => new Response('replayed'),
    })

    expect((await get(fetch)).status).toBe(204)
    expect(reattachSpy).not.toHaveBeenCalled()
  })

  it('returns 204 for a local built-in thread with no runner session', async () => {
    const { fetch, reattachSpy } = buildHarness({
      thread: { acpSessionId: null },
      reattach: async () => new Response('replayed'),
    })

    expect((await get(fetch)).status).toBe(204)
    expect(reattachSpy).not.toHaveBeenCalled()
  })

  it('returns 204 when the deployment configures no runner', async () => {
    const { fetch, getOrConnectAdapter } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      reattach: async () => new Response('replayed'),
      wsUrl: null,
    })

    expect((await get(fetch)).status).toBe(204)
    expect(getOrConnectAdapter).not.toHaveBeenCalled()
  })

  it('returns 204 when the adapter has no reattach', async () => {
    const { fetch } = buildHarness({ thread: { acpSessionId: 'sess-stored' } })

    expect((await get(fetch)).status).toBe(204)
  })

  it('returns 204 when the adapter cannot be connected', async () => {
    const { fetch } = buildHarness({ thread: { acpSessionId: 'sess-stored' }, connectFails: true })

    expect((await get(fetch)).status).toBe(204)
  })

  it('returns 204 without reattaching an encrypted thread — catch-up stays a quiet no-op', async () => {
    const { fetch, reattachSpy } = buildHarness({
      thread: { acpSessionId: 'sess-stored', isEncrypted: 1 },
      reattach: async () => new Response('replayed'),
    })

    expect((await get(fetch)).status).toBe(204)
    expect(reattachSpy).not.toHaveBeenCalled()
  })

  it('lifts a trailing partial and hands its id to reattach so the replay replaces it', async () => {
    const { chatInstance, fetch, reattachSpy } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }, partialMessage],
      reattach: async () => new Response('replayed'),
    })

    await get(fetch)

    expect(reattachSpy?.mock.calls[0]?.[1]).toBe('msg-partial-1')
    expect(chatInstance.messages.map((m) => m.id)).toEqual(['u1'])
  })

  it('restores the lifted partial when there is nothing to replay', async () => {
    const { chatInstance, fetch } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }, partialMessage],
      reattach: async () => null,
    })

    expect((await get(fetch)).status).toBe(204)
    expect(chatInstance.messages).toEqual([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] },
      partialMessage,
    ])
  })

  it('restores the lifted partial when reattach rejects', async () => {
    const { chatInstance, fetch } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      messages: [partialMessage],
      reattach: async () => {
        throw new Error('replay blew up')
      },
    })

    expect((await get(fetch)).status).toBe(204)
    expect(chatInstance.messages).toEqual([partialMessage])
  })

  it('leaves a complete trailing assistant message in place and passes no message id', async () => {
    const complete: ThunderboltUIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'all done' }],
    }
    const { chatInstance, fetch, reattachSpy } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      messages: [complete],
      reattach: async () => new Response('replayed'),
    })

    await get(fetch)

    expect(reattachSpy?.mock.calls[0]?.[1]).toBeUndefined()
    expect(chatInstance.messages).toEqual([complete])
  })

  it('passes the thread session id and the run spec through on the reattach context', async () => {
    const { fetch, reattachSpy } = buildHarness({
      thread: { acpSessionId: 'sess-stored' },
      reattach: async () => new Response('replayed'),
    })

    await get(fetch)

    expect(reattachSpy?.mock.calls[0]?.[0]).toMatchObject({
      threadId: sessionId,
      acpSessionId: 'sess-stored',
      runSpec,
    })
  })
})

describe('createAgentRoutingFetch — encrypted-thread guard on the prompt path', () => {
  beforeEach(resetStore)
  afterEach(resetStore)

  it('refuses to send an encrypted thread to a remote agent', async () => {
    const { adapterFetch, fetch } = buildHarness({ agent: customAgent, thread: { isEncrypted: 1 } })

    await expect(fetch('https://x', { body: '{"messages":[]}' } as RequestInit)).rejects.toThrow(
      'Encrypted conversations can only run on the built-in agent.',
    )
    expect(adapterFetch).not.toHaveBeenCalled()
  })

  it('allows an encrypted thread on the built-in agent', async () => {
    const { adapterFetch, fetch } = buildHarness({ thread: { isEncrypted: 1 } })

    await fetch('https://x', { body: '{"messages":[]}' } as RequestInit)

    expect(adapterFetch).toHaveBeenCalledTimes(1)
  })

  it('allows an unencrypted thread on a remote agent', async () => {
    const { adapterFetch, fetch } = buildHarness({ agent: customAgent, thread: { isEncrypted: 0 } })

    await fetch('https://x', { body: '{"messages":[]}' } as RequestInit)

    expect(adapterFetch).toHaveBeenCalledTimes(1)
  })
})
