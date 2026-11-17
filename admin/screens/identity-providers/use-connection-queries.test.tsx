/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import type { AdminConnectionDetail, ConnectionStatus } from '@shared/admin-api'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { createAdminTestHarness, type FakeRequest } from '../../test-utils'
import { retiringPollMs, useConnection, useRetireScim } from './use-connection-queries'

const detail = (status: ConnectionStatus): AdminConnectionDetail => ({
  id: 'c1',
  name: 'Acme',
  status,
  matchClaim: 'sub',
  sso: null,
  scim: { scimConnectionId: 's1' },
  claimedDomains: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  lockedFields: [],
  scimCredentials: [],
})

/** Advance the fake clock, letting the queries it wakes settle. */
const tick = (ms: number) =>
  act(async () => {
    await getClock().tickAsync(ms)
  })

const detailReads = (requests: FakeRequest[]) =>
  requests.filter((request) => request.method === 'GET' && request.path === 'admin/connections/c1').length

describe('connection queries', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('polls a connection while its SCIM side retires, and stops once it is retired', async () => {
    const statuses: ConnectionStatus[] = ['scim_retiring', 'scim_retiring', 'scim_retired']
    const harness = createAdminTestHarness(() => ({ body: detail(statuses.shift() ?? 'scim_retired') }))
    const { result } = renderHook(() => useConnection('c1'), { wrapper: harness.wrapper })

    await tick(0)
    expect(result.current.data?.status).toBe('scim_retiring')
    await tick(retiringPollMs)
    await tick(retiringPollMs)
    expect(result.current.data?.status).toBe('scim_retired')
    const reads = detailReads(harness.requests)

    await tick(retiringPollMs * 3)
    expect(detailReads(harness.requests)).toBe(reads)
  })

  it('refreshes connections and members after retiring SCIM', async () => {
    const harness = createAdminTestHarness(() => ({ status: 202, body: detail('scim_retiring') }))
    harness.queryClient.setQueryData(adminQueryKeys.members.list(), { stale: true })
    harness.queryClient.setQueryData(adminQueryKeys.connections.list(), [])
    const { result } = renderHook(() => useRetireScim('c1'), { wrapper: harness.wrapper })

    await act(() => result.current.mutateAsync())
    expect(harness.requests.at(-1)).toMatchObject({ method: 'POST', path: 'admin/connections/c1/scim/retire' })
    expect(harness.queryClient.getQueryState(adminQueryKeys.members.list())?.isInvalidated).toBe(true)
    expect(harness.queryClient.getQueryState(adminQueryKeys.connections.list())?.isInvalidated).toBe(true)
  })
})
