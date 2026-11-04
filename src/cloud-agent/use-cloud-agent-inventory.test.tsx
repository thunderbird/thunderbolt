/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AuthProvider, DatabaseProvider, HttpClientProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { getAllAgents } from '@/dal/agents'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import { PowerSyncMockProvider } from '@/test-utils/powersync-mock'
import { cloudAgentViewFixture } from './agent-inventory-fixture'
import { useCloudAgentInventory } from './use-cloud-agent-inventory'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(cleanup)

describe('normal composer cloud inventory subscription', () => {
  it('uses encrypted query cache offline without materializing ordinary agent rows, then clears on account change', async () => {
    const session = { user: { id: 'owner', email: 'owner@example.com', isAnonymous: false } }
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    queryClient.setQueryData(['cloud-agent-encryption', 'owner'], true)
    queryClient.setQueryData(['cloud-agents', 'owner', 'capabilities'], { enabled: true })
    queryClient.setQueryData(['cloud-agents', 'owner', 'agents'], [cloudAgentViewFixture()])
    const authClient = createMockAuthClient({ session })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <PowerSyncMockProvider>
        <DatabaseProvider db={getDb()}>
          <QueryClientProvider client={queryClient}>
            <HttpClientProvider httpClient={createMockHttpClient()}>
              <AuthProvider authClient={authClient}>{children}</AuthProvider>
            </HttpClientProvider>
          </QueryClientProvider>
        </DatabaseProvider>
      </PowerSyncMockProvider>
    )
    const { result, rerender } = renderHook(() => useCloudAgentInventory(), { wrapper })
    expect(result.current.agents.map((agent) => agent.type)).toEqual(['cloud'])
    expect(await getAllAgents(getDb())).toHaveLength(0)
    session.user.isAnonymous = true
    act(() => rerender())
    expect(result.current.agents).toEqual([])
    session.user.isAnonymous = false
    session.user.id = 'another-owner'
    queryClient.setQueryData(['cloud-agent-encryption', 'another-owner'], true)
    queryClient.setQueryData(['cloud-agents', 'another-owner', 'capabilities'], { enabled: true })
    queryClient.setQueryData(['cloud-agents', 'another-owner', 'agents'], [cloudAgentViewFixture()])
    act(() => rerender())
    expect(result.current.agents).toEqual([])
    queryClient.clear()
  })
})
