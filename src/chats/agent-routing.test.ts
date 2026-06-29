/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { wsId } from '@/dal/test-utils'

/**
 * `createAgentRoutingFetch` dispatch tests. Verifies the `customFetch` the AI
 * SDK consumes correctly routes each `chat.sendMessage(...)` to the cached
 * `AgentAdapter` for the session's currently-selected agent, rebuilds when the
 * user switches agents mid-thread, and persists ACP `sessionId` via the DAL.
 *
 * DI is via the exported `CreateChatInstanceDeps` — no `mock.module()`, no
 * `Chat` instance, no real `aiFetchStreamingResponse` invocation.
 */

import '@/testing-library'

import { describe, expect, it, mock } from 'bun:test'
import { useChatStore, type ChatSession } from '@/chats/chat-store'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Agent, AgentAdapter } from '@/types/acp'
import type { ChatThread, Mode, Model, ThunderboltUIMessage } from '@/types'
import type { Chat } from '@ai-sdk/react'
import { createAgentRoutingFetch } from './chat-instance'

const remoteAgent: Agent = {
  id: 'remote-foo',
  name: 'Remote Foo',
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

const otherRemoteAgent: Agent = {
  ...remoteAgent,
  id: 'remote-bar',
  name: 'Remote Bar',
}

const mockMode: Mode = {
  id: 'mode-chat',
  name: 'chat',
  label: 'Chat',
  icon: 'message-square',
  systemPrompt: null,
  isDefault: 1,
  order: 0,
} as Mode

const mockModel: Model = {
  id: 'model-1',
  provider: 'openai',
  name: 'Test Model',
  model: 'gpt-4',
  isSystem: 0,
  enabled: 1,
  isConfidential: 0,
} as Model

const mockChatInstance = {
  id: 'thread-1',
  messages: [] as ThunderboltUIMessage[],
} as unknown as Chat<ThunderboltUIMessage>

const httpClient: HttpClient = {} as HttpClient
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn
const saveMessages = mock(async () => {})

/** Build an `AgentAdapter` that records every fetch + tracks disconnect. */
const buildFakeAdapter = (agent: Agent) => {
  const fetch = mock(async () => new Response('streamed'))
  const disconnect = mock(() => {})
  const adapter: AgentAdapter = {
    agent,
    capabilities: null,
    fetch: fetch as unknown as AgentAdapter['fetch'],
    ensureSession: async () => {},
    disconnect,
  }
  return { adapter, fetch, disconnect }
}

const hydrateSessionWith = (id: string, agent: Agent, chatThread: ChatThread | null = null) => {
  const session: ChatSession = {
    chatInstance: mockChatInstance,
    chatThread,
    connectionStatus: 'idle',
    connectionError: null,
    id,
    workspaceId: wsId,
    pendingPermission: null,
    retryCount: 0,
    retriesExhausted: false,
    selectedAgent: agent,
    selectedMode: mockMode,
    selectedModel: mockModel,
    triggerData: null,
  }
  useChatStore.setState({
    currentSessionId: id,
    getMcpClients: () => [],
    modes: [mockMode],
    models: [mockModel],
    sessions: new Map([[id, session]]),
  })
}

describe('createAgentRoutingFetch', () => {
  it('routes built-in agent through connectToAgent with type "built-in"', async () => {
    resetStore()
    const { adapter, fetch: adapterFetch } = buildFakeAdapter(builtInAgent)
    const connectToAgent = mock(async (_agent: Agent) => adapter)
    hydrateSessionWith('t-built-in', builtInAgent)

    const customFetch = createAgentRoutingFetch('t-built-in', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
    })

    const init: RequestInit = { method: 'POST', body: '{}' }
    await customFetch('/chat', init)

    expect(connectToAgent).toHaveBeenCalledTimes(1)
    expect(connectToAgent.mock.calls[0]?.[0]).toBe(builtInAgent)
    expect(connectToAgent.mock.calls[0]?.[0]?.type).toBe('built-in')
    expect(adapterFetch).toHaveBeenCalledTimes(1)
  })

  it('routes remote-acp agent through connectToAgent with type "remote-acp"', async () => {
    resetStore()
    const { adapter, fetch: adapterFetch } = buildFakeAdapter(remoteAgent)
    const connectToAgent = mock(async (_agent: Agent) => adapter)
    hydrateSessionWith('t-remote', remoteAgent)

    const customFetch = createAgentRoutingFetch('t-remote', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
    })

    await customFetch('/chat', { method: 'POST', body: '{}' })

    expect(connectToAgent).toHaveBeenCalledTimes(1)
    expect(connectToAgent.mock.calls[0]?.[0]?.type).toBe('remote-acp')
    expect(adapterFetch).toHaveBeenCalledTimes(1)
  })

  it('reuses the cached adapter across sequential fetches with the same agent', async () => {
    resetStore()
    const { adapter, fetch: adapterFetch } = buildFakeAdapter(remoteAgent)
    const connectToAgent = mock(async (_agent: Agent) => adapter)
    hydrateSessionWith('t-cache', remoteAgent)

    const customFetch = createAgentRoutingFetch('t-cache', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
    })

    await customFetch('/chat', { method: 'POST', body: '{}' })
    await customFetch('/chat', { method: 'POST', body: '{}' })
    await customFetch('/chat', { method: 'POST', body: '{}' })

    expect(connectToAgent).toHaveBeenCalledTimes(1)
    expect(adapterFetch).toHaveBeenCalledTimes(3)
  })

  it('routes to the new agent WITHOUT disconnecting the previous one when selectedAgent changes mid-session', async () => {
    resetStore()
    const first = buildFakeAdapter(remoteAgent)
    const second = buildFakeAdapter(otherRemoteAgent)

    const connectToAgent = mock(async (agent: Agent) => (agent.id === remoteAgent.id ? first.adapter : second.adapter))

    hydrateSessionWith('t-switch', remoteAgent)

    const customFetch = createAgentRoutingFetch('t-switch', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
    })

    await customFetch('/chat', { method: 'POST', body: '{}' })
    expect(first.fetch).toHaveBeenCalledTimes(1)
    expect(first.disconnect).not.toHaveBeenCalled()

    // User switches to a different agent on the same thread. The previous
    // agent's shared connection must stay warm — other threads may use it.
    // Update the in-memory selection directly (this DB-free DI suite doesn't
    // register a database; `setSelectedAgent` now persists the last-used agent
    // via the DAL, which routing doesn't depend on).
    hydrateSessionWith('t-switch', otherRemoteAgent)

    await customFetch('/chat', { method: 'POST', body: '{}' })
    expect(first.disconnect).not.toHaveBeenCalled()
    expect(connectToAgent).toHaveBeenCalledTimes(2)
    expect(second.fetch).toHaveBeenCalledTimes(1)
  })

  it('persists ACP sessionId via updateChatThread when onAcpSessionId is invoked by the adapter', async () => {
    resetStore()
    const chatThread = { id: 'thread-77', acpSessionId: null } as ChatThread
    const disconnect = mock(() => {})
    const fakeDb = { __id: 'fake-db' } as never

    // `onAcpSessionId` now travels on the per-FETCH context (the shared
    // connection resolves a session per thread), so capture it there.
    let capturedOnAcpSessionId: ((id: string) => Promise<void>) | null = null
    const fetch = mock(async (_init: RequestInit, ctx: { onAcpSessionId: (id: string) => Promise<void> }) => {
      capturedOnAcpSessionId = ctx.onAcpSessionId
      return new Response('streamed')
    })
    const connectToAgent = mock(
      async () =>
        ({
          agent: remoteAgent,
          capabilities: null,
          fetch: fetch as unknown as AgentAdapter['fetch'],
          ensureSession: async () => {},
          disconnect,
        }) as AgentAdapter,
    )

    const updateChatThread = mock(async () => {})

    hydrateSessionWith('thread-77', remoteAgent, chatThread)

    const customFetch = createAgentRoutingFetch('thread-77', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: updateChatThread as never,
      getDb: (() => fakeDb) as never,
    })

    await customFetch('/chat', { method: 'POST', body: '{}' })

    expect(capturedOnAcpSessionId).not.toBeNull()

    // Simulate the adapter calling back with a fresh ACP session id.
    await capturedOnAcpSessionId!('acp-sess-xyz')

    expect(updateChatThread).toHaveBeenCalledTimes(1)
    const call = updateChatThread.mock.calls[0] as unknown as [unknown, string, string, { acpSessionId: string }]
    expect(call[0]).toBe(fakeDb)
    expect(call[1]).toBe(wsId)
    expect(call[2]).toBe('thread-77')
    expect(call[3]).toMatchObject({ acpSessionId: 'acp-sess-xyz' })
  })

  it('saves the user message before invoking the adapter (built-in agent)', async () => {
    resetStore()
    const order: string[] = []
    const saveMessagesSpy = mock(async (_args: { id: string; messages: ThunderboltUIMessage[] }) => {
      order.push('save')
    })
    const adapterFetch = mock(async () => {
      order.push('fetch')
      return new Response('streamed')
    })
    const adapter: AgentAdapter = {
      agent: builtInAgent,
      capabilities: null,
      fetch: adapterFetch as unknown as AgentAdapter['fetch'],
      ensureSession: async () => {},
      disconnect: mock(() => {}),
    }
    const connectToAgent = mock(async () => adapter)
    hydrateSessionWith('t-save-builtin', builtInAgent)

    const userMessage: ThunderboltUIMessage = {
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello world' }],
    }

    const customFetch = createAgentRoutingFetch('t-save-builtin', wsId, saveMessagesSpy, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
    })

    await customFetch('/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage], id: 't-save-builtin' }),
    })

    expect(saveMessagesSpy).toHaveBeenCalledTimes(1)
    expect(saveMessagesSpy.mock.calls[0]?.[0]).toEqual({ id: 't-save-builtin', messages: [userMessage] })
    expect(order).toEqual(['save', 'fetch'])
  })

  it('saves the user message before invoking the adapter (remote-acp agent)', async () => {
    resetStore()
    const saveMessagesSpy = mock(async (_args: { id: string; messages: ThunderboltUIMessage[] }) => {})
    const { adapter } = buildFakeAdapter(remoteAgent)
    const connectToAgent = mock(async () => adapter)
    hydrateSessionWith('t-save-remote', remoteAgent)

    const userMessage: ThunderboltUIMessage = {
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'ACP question' }],
    }

    const customFetch = createAgentRoutingFetch('t-save-remote', wsId, saveMessagesSpy, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
    })

    await customFetch('/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage], id: 't-save-remote' }),
    })

    expect(saveMessagesSpy).toHaveBeenCalledTimes(1)
    expect(saveMessagesSpy.mock.calls[0]?.[0]).toEqual({ id: 't-save-remote', messages: [userMessage] })
  })

  it('does NOT persist acpSessionId when the session has no chatThread (new chat)', async () => {
    resetStore()
    const disconnect = mock(() => {})
    const fakeDb = { __id: 'fake-db' } as never

    let capturedOnAcpSessionId: ((id: string) => Promise<void>) | null = null
    const fetch = mock(async (_init: RequestInit, ctx: { onAcpSessionId: (id: string) => Promise<void> }) => {
      capturedOnAcpSessionId = ctx.onAcpSessionId
      return new Response('streamed')
    })
    const connectToAgent = mock(
      async () =>
        ({
          agent: remoteAgent,
          capabilities: null,
          fetch: fetch as unknown as AgentAdapter['fetch'],
          ensureSession: async () => {},
          disconnect,
        }) as AgentAdapter,
    )

    const updateChatThread = mock(async () => {})

    hydrateSessionWith('t-no-thread', remoteAgent, null)

    const customFetch = createAgentRoutingFetch('t-no-thread', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: updateChatThread as never,
      getDb: (() => fakeDb) as never,
    })

    await customFetch('/chat', { method: 'POST', body: '{}' })
    await capturedOnAcpSessionId!('any-sess')

    expect(updateChatThread).not.toHaveBeenCalled()
  })

  it('resolves user-skill instructions into the fetch context for a remote-acp agent', async () => {
    resetStore()
    const { adapter, fetch: adapterFetch } = buildFakeAdapter(remoteAgent)
    const connectToAgent = mock(async () => adapter)
    const getAllSkills = mock(async () => [
      { id: 's1', name: 'tell-a-joke', description: 'd', instruction: 'Tell a cat joke.', enabled: 1 },
    ])
    hydrateSessionWith('t-skill', remoteAgent)

    const customFetch = createAgentRoutingFetch('t-skill', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      getAllSkills: getAllSkills as never,
      getDb: (() => ({})) as never,
    })

    const body = JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: '/tell-a-joke' }] }] })
    await customFetch('/chat', { method: 'POST', body })

    const [, ctx] = adapterFetch.mock.calls[0] as unknown as [unknown, { skillInstructions?: string[] }]
    expect(ctx.skillInstructions).toEqual(['Tell a cat joke.'])
  })

  it('does not resolve skill instructions for the built-in agent (it injects them itself)', async () => {
    resetStore()
    const { adapter, fetch: adapterFetch } = buildFakeAdapter(builtInAgent)
    const connectToAgent = mock(async () => adapter)
    const getAllSkills = mock(async () => [])
    hydrateSessionWith('t-builtin-skill', builtInAgent)

    const customFetch = createAgentRoutingFetch('t-builtin-skill', wsId, saveMessages, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      getAllSkills: getAllSkills as never,
      getDb: (() => ({})) as never,
    })

    const body = JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: '/tell-a-joke' }] }] })
    await customFetch('/chat', { method: 'POST', body })

    const [, ctx] = adapterFetch.mock.calls[0] as unknown as [unknown, { skillInstructions?: string[] }]
    expect(ctx.skillInstructions).toBeUndefined()
    expect(getAllSkills).not.toHaveBeenCalled()
  })
})
