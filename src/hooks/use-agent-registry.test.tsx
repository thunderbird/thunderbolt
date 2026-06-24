/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { agentRegistrySnapshot } from '@/defaults/agent-registry'
import type { FetchFn } from '@/lib/proxy-fetch'
import { getClock } from '@/testing-library'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { useAgentRegistry } from './use-agent-registry'

/** A `FetchFn` that always resolves to `body` as a JSON `Response`. */
const proxyFetchReturning = (body: unknown): FetchFn =>
  Object.assign(
    async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    { preconnect: () => Promise.resolve(false) },
  ) as FetchFn

describe('useAgentRegistry', () => {
  it('returns the bundled snapshot immediately as initialData', () => {
    const { result } = renderHook(() => useAgentRegistry(), { wrapper: createQueryTestWrapper() })
    expect(result.current).toBe(agentRegistrySnapshot)
  })

  it('updates with the live registry when the proxy fetch succeeds', async () => {
    const liveRegistry = {
      version: '9.9.9',
      agents: [{ id: 'live-only', name: 'Live Only', distribution: {} }],
    }
    const wrapper = createQueryTestWrapper({ proxyFetch: proxyFetchReturning(liveRegistry) })
    const { result } = renderHook(() => useAgentRegistry(), { wrapper })

    // Seeded immediately from the snapshot...
    expect(result.current).toBe(agentRegistrySnapshot)

    // ...then refreshed from the live proxy response. (The global fake-timer
    // setup makes refetch-on-mount timing unreliable, so drive it explicitly.)
    await act(async () => {
      await wrapper.queryClient.refetchQueries({ queryKey: ['acp-agent-registry'] })
      await getClock().runAllAsync()
    })

    expect(result.current.map((entry) => entry.id)).toEqual(['live-only'])
  })

  it('keeps the snapshot when the live response is empty (degenerate-response guard)', async () => {
    const wrapper = createQueryTestWrapper({ proxyFetch: proxyFetchReturning({ agents: [] }) })
    const { result } = renderHook(() => useAgentRegistry(), { wrapper })

    await act(async () => {
      await wrapper.queryClient.refetchQueries({ queryKey: ['acp-agent-registry'] })
      await getClock().runAllAsync()
    })

    expect(result.current).toEqual(agentRegistrySnapshot)
  })
})
