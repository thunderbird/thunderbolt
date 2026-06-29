/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { wsId } from '@/dal/test-utils'

/**
 * Tests that the routing fetch's permission bridge stashes pending requests
 * on the store and that `resolvePendingPermission` completes the adapter's
 * awaited promise.
 */

import '@/testing-library'

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

  it('routes the adapter requestPermission into the store and resolves on dialog response', async () => {
    // `requestPermission` now travels on the per-FETCH context — a shared agent
    // connection routes each thread's prompts to its own handler — so capture
    // it from `adapter.fetch`, not the connect context.
    let capturedRequestPermission: AgentAdapterContext['requestPermission'] | undefined

    const adapter: AgentAdapter = {
      agent: {} as Agent,
      capabilities: null,
      fetch: async (_init: RequestInit, ctx: AgentAdapterContext) => {
        capturedRequestPermission = ctx.requestPermission
        return new Response('ok')
      },
      ensureSession: async () => {},
      disconnect: () => {},
    }

    const connectToAgent = mock(async () => adapter)

    const fetch = createAgentRoutingFetch(sessionId, wsId, async () => {}, httpClient, getProxyFetch, {
      connectToAgent: connectToAgent as never,
      updateChatThread: (async () => {}) as never,
      getDb: (() => ({})) as never,
    })

    await fetch('http://x', { body: '{}' } as RequestInit)

    expect(capturedRequestPermission).toBeDefined()

    const request: RequestPermissionRequest = {
      sessionId: 'remote',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      toolCall: { toolCallId: 't', title: 'do thing', status: 'pending' },
    } as RequestPermissionRequest

    const promise = capturedRequestPermission!(request)

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
