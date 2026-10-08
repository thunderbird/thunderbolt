/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useChatStore } from '@/chats/chat-store'
import { updateSettings } from '@/dal/settings'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { RefreshSystemAgentsResult } from '@/db/seeding/seed-agents'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockAuthClient } from '@/test-utils/auth-client'
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
  useLocalSettingsStore.setState({ cloudUrl: 'http://localhost:8000/v1' })
})

afterEach(() => {
  useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
})

describe('useBootstrapSystemAgents', () => {
  it('runs discovery for an anonymous session and applies the discovered default', async () => {
    const refresh = mock(async () => refreshed)
    const applyDefault = spyOn(useChatStore.getState(), 'applyDiscoveredDefaultAgent')

    renderHook(() => useBootstrapSystemAgents({ refresh }), {
      wrapper: createTestProvider({ authClient: createMockAuthClient({ session: anonymousSession }) }),
    })

    await act(async () => {})

    expect(applyDefault).toHaveBeenCalledWith(hostedAgent, null)
    expect(refresh).toHaveBeenCalledTimes(1)
    applyDefault.mockRestore()
  })

  it("hands the user's remembered agent to the store so a deliberate pick is not overridden", async () => {
    await updateSettings(getDb(), { selected_agent: 'custom-agent' })
    const applyDefault = spyOn(useChatStore.getState(), 'applyDiscoveredDefaultAgent')

    renderHook(() => useBootstrapSystemAgents({ refresh: mock(async () => refreshed) }), {
      wrapper: createTestProvider({ authClient: createMockAuthClient({ session: anonymousSession }) }),
    })

    await act(async () => {})

    expect(applyDefault).toHaveBeenCalledWith(hostedAgent, 'custom-agent')
    applyDefault.mockRestore()
  })

  it('skips discovery without a session', () => {
    const refresh = mock(async () => refreshed)

    renderHook(() => useBootstrapSystemAgents({ refresh }), {
      wrapper: createTestProvider({ authClient: createMockAuthClient({ session: null }) }),
    })

    expect(refresh).not.toHaveBeenCalled()
  })
})
