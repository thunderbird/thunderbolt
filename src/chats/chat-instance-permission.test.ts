/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { builtInAgent } from '@/defaults/agents'
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { HttpClient } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import type { Agent, AgentAdapter, AgentAdapterContext } from '@/types/acp'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatStore } from './chat-store'
import { createAgentRoutingFetch } from './chat-instance'

const sessionId = 'sess-p1'
const httpClient: HttpClient = {} as HttpClient
const getProxyFetch: () => FetchFn = () => (async () => new Response('ok')) as unknown as FetchFn
const remoteAgent: Agent = {
  id: 'remote-agent',
  name: 'Remote Agent',
  type: 'remote-acp',
  transport: 'websocket',
  url: 'wss://example.test/ws',
  description: null,
  icon: null,
  isSystem: 0,
  enabled: 1,
  deletedAt: null,
  userId: 'user-1',
}

const hydrate = () => {
  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: null,
    id: sessionId,
    selectedModel: { id: 'm1', isConfidential: 0 } as never,
    triggerData: null,
  })
}

describe('requestPermission bridge', () => {
  beforeEach(() => {
    resetStore()
    hydrate()
  })

  afterEach(() => {
    resetStore()
  })

  it('omits requestPermission for the built-in agent', async () => {
    const contexts: AgentAdapterContext[] = []

    const adapter: AgentAdapter = {
      agent: builtInAgent,
      capabilities: null,
      fetch: async (_init: RequestInit, ctx: AgentAdapterContext) => {
        contexts.push(ctx)
        return new Response('ok')
      },
      ensureSession: async () => {},
      disconnect: () => {},
    }

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      connectToAgent: mock(async () => adapter) as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('http://x', { body: '{}' } as RequestInit)

    expect(contexts[0].requestPermission).toBeUndefined()
  })

  it('routes an ACP requestPermission into the store and resolves on dialog response', async () => {
    const contexts: AgentAdapterContext[] = []

    const adapter: AgentAdapter = {
      agent: remoteAgent,
      capabilities: null,
      fetch: async (_init: RequestInit, ctx: AgentAdapterContext) => {
        contexts.push(ctx)
        return new Response('ok')
      },
      ensureSession: async () => {},
      disconnect: () => {},
    }

    const connectToAgent = mock(async () => adapter)

    useChatStore.getState().updateSession(sessionId, { selectedAgent: remoteAgent })

    const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('http://x', { body: '{}' } as RequestInit)

    expect(contexts[0].requestPermission).toBeDefined()

    const request: RequestPermissionRequest = {
      sessionId: 'remote',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      toolCall: { toolCallId: 't', title: 'do thing', status: 'pending' },
    } as RequestPermissionRequest

    const promise = contexts[0].requestPermission!(request)

    const pending = useChatStore.getState().sessions.get(sessionId)!.pendingPermission
    expect(pending).not.toBeNull()
    expect(pending!.request).toBe(request)

    const response: RequestPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow' } }
    useChatStore.getState().resolvePendingPermission(sessionId, response)

    await expect(promise).resolves.toEqual(response)
    expect(useChatStore.getState().sessions.get(sessionId)!.pendingPermission).toBeNull()
  })

  it('resolvePendingPermission is a no-op when there is no pending request', () => {
    useChatStore.getState().resolvePendingPermission(sessionId, {
      outcome: { outcome: 'cancelled' },
    })
    expect(useChatStore.getState().sessions.get(sessionId)!.pendingPermission).toBeNull()
  })
})
