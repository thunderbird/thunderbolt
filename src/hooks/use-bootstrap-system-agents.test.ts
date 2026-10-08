/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useChatStore } from '@/chats/chat-store'
import { updateSettings } from '@/dal/settings'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { RefreshSystemAgentsResult } from '@/db/seeding/seed-agents'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockChatInstanceWithValidation, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createTestProvider } from '@/test-utils/test-provider'
import type { Agent } from '@/types/acp'
import { useBootstrapSystemAgents } from './use-bootstrap-system-agents'

const hostedAgent: Agent = {
  id: 'hosted-agent',
  name: 'Assistant',
  type: 'managed-http',
  transport: 'http',
  url: '/v1/agent/chat',
  description: null,
  icon: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

const refreshed: RefreshSystemAgentsResult = {
  refreshed: true,
  wireIdentityChangedAgents: [],
  defaultAgent: hostedAgent,
}
const anonymousSession = { user: { id: 'anon-1', email: '', isAnonymous: true } }
const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  resetStore()
  useLocalSettingsStore.setState({ cloudUrl: 'http://localhost:8000/v1' })
})

afterEach(() => {
  useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
})

/** An unsent new chat on the built-in agent, as hydration leaves it when discovery has not landed. */
const hydrateUnstartedChat = () =>
  hydrateStore({
    id: 'unstarted',
    chatInstance: createMockChatInstanceWithValidation(),
    chatThread: null,
    selectedModel: null,
    triggerData: null,
  })

const agentOfUnstartedChat = () => useChatStore.getState().sessions.get('unstarted')?.selectedAgent.id

describe('useBootstrapSystemAgents', () => {
  it('runs discovery for an anonymous session and applies the discovered default', async () => {
    hydrateUnstartedChat()
    const refresh = mock(async () => refreshed)

    renderHook(() => useBootstrapSystemAgents({ refresh }), {
      wrapper: createTestProvider({ authClient: createMockAuthClient({ session: anonymousSession }) }),
    })

    await act(async () => {})

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().discoveredDefaultAgent).toEqual(hostedAgent)
    expect(agentOfUnstartedChat()).toBe(hostedAgent.id)
  })

  it("hands the user's remembered agent to the store so a deliberate pick is not overridden", async () => {
    hydrateUnstartedChat()
    await updateSettings(getDb(), { selected_agent: 'thunderbolt-built-in' })

    renderHook(() => useBootstrapSystemAgents({ refresh: mock(async () => refreshed) }), {
      wrapper: createTestProvider({ authClient: createMockAuthClient({ session: anonymousSession }) }),
    })

    await act(async () => {})

    expect(agentOfUnstartedChat()).toBe('thunderbolt-built-in')
  })

  it('aborts the anonymous refresh on sign-in so its late answer is ignored', async () => {
    const signedInSession = { user: { id: 'user-1', email: 'user@example.test', isAnonymous: false } }
    let currentSession: typeof anonymousSession | typeof signedInSession = anonymousSession
    const baseClient = createMockAuthClient({ session: anonymousSession })
    const authClient = {
      ...baseClient,
      useSession: () => ({ ...baseClient.useSession(), data: currentSession }),
    } as typeof baseClient
    const signals: AbortSignal[] = []
    const settleAnonymous: { resolve?: (result: RefreshSystemAgentsResult) => void } = {}
    const refresh = mock((_db: unknown, _client: unknown, signal?: AbortSignal) => {
      signals.push(signal!)
      return signals.length === 1
        ? new Promise<RefreshSystemAgentsResult>((resolve) => {
            settleAnonymous.resolve = resolve
          })
        : Promise.resolve(refreshed)
    })

    const { rerender } = renderHook(() => useBootstrapSystemAgents({ refresh }), {
      wrapper: createTestProvider({ authClient }),
    })
    currentSession = signedInSession
    rerender()
    await act(async () => {})
    // The anonymous answer lands last. Applied, it would clear the default.
    await act(async () => {
      settleAnonymous.resolve!({ refreshed: false, reason: 'unauthenticated' })
    })

    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    expect(useChatStore.getState().discoveredDefaultAgent).toEqual(hostedAgent)
  })

  it('skips discovery without a session', () => {
    const refresh = mock(async () => refreshed)

    renderHook(() => useBootstrapSystemAgents({ refresh }), {
      wrapper: createTestProvider({ authClient: createMockAuthClient({ session: null }) }),
    })

    expect(refresh).not.toHaveBeenCalled()
  })
})
