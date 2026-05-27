/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `createAgentRoutingFetch` connection-status tests. Verifies the customFetch
 * factory writes `connectionStatus` transitions into the chat-store around
 * each call to the injected `connectToAgent`.
 */

import '@/testing-library'

import { builtInAgent } from '@/defaults/agents'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import type { Agent, AgentAdapter } from '@/types/acp'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatStore } from './chat-store'
import { createAgentRoutingFetch } from './chat-instance'

const sessionId = 'sess-1'
const httpClient: HttpClient = {} as HttpClient
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn

const makeAdapter = (agent: Agent): AgentAdapter => ({
  agent,
  capabilities: null,
  fetch: async () => new Response('ok'),
  disconnect: () => {},
})

const hydrate = () => {
  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: null,
    id: sessionId,
    selectedModel: { id: 'm1', isConfidential: 0 } as never,
    triggerData: null,
  })
}

describe('createAgentRoutingFetch — connection status', () => {
  beforeEach(() => {
    resetStore()
    hydrate()
  })

  afterEach(() => {
    resetStore()
  })

  it('transitions connecting → ready when connectToAgent resolves', async () => {
    const observed: string[] = []
    const connectToAgent = mock(async (agent: Agent) => {
      observed.push(useChatStore.getState().sessions.get(sessionId)!.connectionStatus)
      return makeAdapter(agent)
    })

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('http://x', { body: '{}' } as RequestInit)

    expect(observed).toEqual(['connecting'])
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionStatus).toBe('ready')
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionError).toBeNull()
  })

  it('transitions connecting → error when connectToAgent throws', async () => {
    const connectToAgent = mock(async () => {
      throw new Error('boom')
    })

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await expect(fetch('http://x', { body: '{}' } as RequestInit)).rejects.toThrow('boom')

    const session = useChatStore.getState().sessions.get(sessionId)!
    expect(session.connectionStatus).toBe('error')
    expect(session.connectionError?.message).toBe('boom')
  })

  it('only re-connects when the agent identity changes (cache hit stays ready)', async () => {
    const connectToAgent = mock(async (agent: Agent) => makeAdapter(agent))

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('http://x', { body: '{}' } as RequestInit)
    await fetch('http://x', { body: '{}' } as RequestInit)

    expect(connectToAgent).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionStatus).toBe('ready')
  })

  it('re-enters connecting when agent identity changes between calls', async () => {
    const altAgent: Agent = { ...builtInAgent, id: 'alt' }
    const connectToAgent = mock(async (agent: Agent) => makeAdapter(agent))

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('http://x', { body: '{}' } as RequestInit)
    useChatStore.getState().updateSession(sessionId, { selectedAgent: altAgent })
    await fetch('http://x', { body: '{}' } as RequestInit)

    expect(connectToAgent).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().sessions.get(sessionId)!.connectionStatus).toBe('ready')
  })
})
