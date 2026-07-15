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

/** Clears session-only permission state between randomized tests. */
const resetPermissionAllowances = () => {
  useChatStore.setState({ alwaysAllowedAgentIds: new Set(), alwaysAllowedAgentToolKeys: new Set() })
}

/** Captures the permission sink passed to a real ACP adapter context. */
const getRemoteRequestPermission = async (): Promise<NonNullable<AgentAdapterContext['requestPermission']>> => {
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

  useChatStore.getState().updateSession(sessionId, { selectedAgent: remoteAgent })

  const fetch = createAgentRoutingFetch(sessionId, async () => {}, httpClient, getProxyFetch, {
    connectToAgent: mock(async () => adapter) as never,
    updateChatThread: (async () => {}) as never,
    getDb: (() => ({})) as never,
  })

  await fetch('https://x', { body: '{}' } as RequestInit)

  const requestPermission = contexts[0].requestPermission
  if (!requestPermission) {
    throw new Error('ACP permission sink missing')
  }

  return requestPermission
}

describe('requestPermission bridge', () => {
  beforeEach(() => {
    resetStore()
    resetPermissionAllowances()
    hydrate()
  })

  afterEach(() => {
    resetStore()
    resetPermissionAllowances()
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

    await fetch('https://x', { body: '{}' } as RequestInit)

    expect(contexts[0].requestPermission).toBeUndefined()
  })

  it('routes an ACP requestPermission into the store and resolves on dialog response', async () => {
    const requestPermission = await getRemoteRequestPermission()

    const request: RequestPermissionRequest = {
      sessionId: 'remote',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      toolCall: { toolCallId: 't', title: 'do thing', status: 'pending' },
    } as RequestPermissionRequest

    const promise = requestPermission(request)

    const pending = useChatStore.getState().sessions.get(sessionId)!.pendingPermission
    expect(pending).not.toBeNull()
    expect(pending!.agentId).toBe(remoteAgent.id)
    expect(pending!.request).toBe(request)

    const response: RequestPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow' } }
    useChatStore.getState().resolvePendingPermission(sessionId, response)

    await expect(promise).resolves.toEqual(response)
    expect(useChatStore.getState().sessions.get(sessionId)!.pendingPermission).toBeNull()
  })

  it('auto-approves an allowed ACP tool kind across titles but prompts for another kind', async () => {
    const requestPermission = await getRemoteRequestPermission()
    const firstExecuteRequest: RequestPermissionRequest = {
      sessionId: 'remote',
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      ],
      toolCall: { toolCallId: 't1', title: 'Run pwd', kind: 'execute', status: 'pending' },
    } as RequestPermissionRequest
    const secondExecuteRequest: RequestPermissionRequest = {
      ...firstExecuteRequest,
      toolCall: { toolCallId: 't2', title: 'Run whoami', kind: 'execute', status: 'pending' },
    } as RequestPermissionRequest
    const readRequest: RequestPermissionRequest = {
      ...firstExecuteRequest,
      toolCall: { toolCallId: 't3', title: 'Read /etc/passwd', kind: 'read', status: 'pending' },
    } as RequestPermissionRequest

    useChatStore.getState().allowAlwaysForTool(remoteAgent.id, 'execute')

    await expect(requestPermission(firstExecuteRequest)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
    await expect(requestPermission(secondExecuteRequest)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
    expect(useChatStore.getState().sessions.get(sessionId)!.pendingPermission).toBeNull()

    const readPromise = requestPermission(readRequest)
    expect(useChatStore.getState().sessions.get(sessionId)!.pendingPermission?.request).toBe(readRequest)

    const response: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    useChatStore.getState().resolvePendingPermission(sessionId, response)
    await expect(readPromise).resolves.toEqual(response)
  })

  it('opens the dialog for an always-allowed agent when no allow option exists', async () => {
    const requestPermission = await getRemoteRequestPermission()
    const request: RequestPermissionRequest = {
      sessionId: 'remote',
      options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      toolCall: { toolCallId: 't', title: 'do thing', status: 'pending' },
    } as RequestPermissionRequest

    useChatStore.getState().allowAlwaysForAgent(remoteAgent.id)

    const promise = requestPermission(request)
    expect(useChatStore.getState().sessions.get(sessionId)!.pendingPermission?.request).toBe(request)

    const response: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
    useChatStore.getState().resolvePendingPermission(sessionId, response)
    await expect(promise).resolves.toEqual(response)
  })

  it('resolvePendingPermission is a no-op when there is no pending request', () => {
    useChatStore.getState().resolvePendingPermission(sessionId, {
      outcome: { outcome: 'cancelled' },
    })
    expect(useChatStore.getState().sessions.get(sessionId)!.pendingPermission).toBeNull()
  })
})
