/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { OrgDomain } from '@shared/admin-api'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { createAdminTestHarness, flush, type FakeRequest, type FakeReply } from '../../test-utils'
import { makeConnection, makeDomain } from './fixtures'
import {
  useAddDomain,
  useClaimDomain,
  useClaimableConnections,
  useDomains,
  useRemoveDomain,
  useVerifyDomain,
} from './use-domains'

const listKey = adminQueryKeys.domains.list()

/** A backend holding `domains`, answering every change to one with `change`. */
const backend =
  (domains: OrgDomain[], change: (request: FakeRequest) => FakeReply) =>
  (request: FakeRequest): FakeReply => {
    if (request.method === 'GET' && request.path === 'admin/domains') {
      return { body: { items: domains } }
    }
    if (request.method === 'GET' && request.path === 'admin/connections') {
      return { body: { items: [makeConnection(), makeConnection({ id: 'c2', status: 'retired' })] } }
    }
    return change(request)
  }

const gets = (requests: FakeRequest[], path: string) =>
  requests.filter((request) => request.method === 'GET' && request.path === path).length

describe('domain queries', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('adds a domain into the list in domain order', async () => {
    const added = makeDomain({ id: 'd0', domain: 'acme.test' })
    const harness = createAdminTestHarness(backend([makeDomain()], () => ({ body: added })))
    const { result } = renderHook(() => ({ list: useDomains(), add: useAddDomain() }), { wrapper: harness.wrapper })
    await flush()

    await act(() => result.current.add.mutateAsync('acme.test'))

    expect(harness.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: 'admin/domains',
      body: { domain: 'acme.test' },
    })
    expect(harness.queryClient.getQueryData<OrgDomain[]>(listKey)?.map((item) => item.domain)).toEqual([
      'acme.test',
      'example.com',
    ])
    expect(gets(harness.requests, 'admin/domains')).toBe(1)
  })

  it('writes a verified domain back into the list without a refetch', async () => {
    const verified = makeDomain({ verifiedAt: '2026-11-17T01:00:00.000Z' })
    const harness = createAdminTestHarness(backend([makeDomain()], () => ({ body: verified })))
    const { result } = renderHook(() => ({ list: useDomains(), verify: useVerifyDomain('d1') }), {
      wrapper: harness.wrapper,
    })
    await flush()

    await act(() => result.current.verify.mutateAsync())
    await flush()

    expect(harness.requests.at(-1)).toMatchObject({ method: 'POST', path: 'admin/domains/d1/verify' })
    expect(result.current.list.data?.[0].verifiedAt).toBe(verified.verifiedAt)
    expect(gets(harness.requests, 'admin/domains')).toBe(1)
  })

  it('refreshes the connections after a claim', async () => {
    const claimed = makeDomain({ verifiedAt: '2026-11-17T01:00:00.000Z', claimedBy: { id: 'c1', name: 'Okta' } })
    const harness = createAdminTestHarness(backend([makeDomain()], () => ({ body: claimed })))
    const { result } = renderHook(
      () => ({ list: useDomains(), connections: useClaimableConnections(), claim: useClaimDomain('d1') }),
      { wrapper: harness.wrapper },
    )
    await flush()
    expect(result.current.connections.data?.map((connection) => connection.id)).toEqual(['c1'])

    await act(() => result.current.claim.mutateAsync('c1'))
    await flush()

    expect(harness.requests.find((request) => request.method === 'PUT')).toMatchObject({
      path: 'admin/domains/d1/claim',
      body: { identityConnectionId: 'c1' },
    })
    expect(result.current.list.data?.[0].claimedBy?.name).toBe('Okta')
    expect(gets(harness.requests, 'admin/connections')).toBe(2)
  })

  it('refetches the list when a change is refused', async () => {
    const harness = createAdminTestHarness(
      backend([makeDomain()], () => ({ status: 404, body: { code: 'DOMAIN_NOT_FOUND' } })),
    )
    const { result } = renderHook(() => ({ list: useDomains(), verify: useVerifyDomain('d1') }), {
      wrapper: harness.wrapper,
    })
    await flush()

    await act(() => result.current.verify.mutateAsync().catch(() => {}))
    await flush()

    expect(gets(harness.requests, 'admin/domains')).toBe(2)
  })

  it('refetches the list when a removal is refused', async () => {
    const harness = createAdminTestHarness(
      backend([makeDomain()], () => ({ status: 409, body: { code: 'DOMAIN_CLAIMED_BY_IDP' } })),
    )
    const { result } = renderHook(() => ({ list: useDomains(), remove: useRemoveDomain() }), {
      wrapper: harness.wrapper,
    })
    await flush()

    await act(() => result.current.remove.mutateAsync('d1').catch(() => {}))
    await flush()

    expect(gets(harness.requests, 'admin/domains')).toBe(2)
  })

  it('drops a removed domain from the list', async () => {
    const harness = createAdminTestHarness(backend([makeDomain()], () => ({ status: 204 })))
    const { result } = renderHook(() => ({ list: useDomains(), remove: useRemoveDomain() }), {
      wrapper: harness.wrapper,
    })
    await flush()

    await act(() => result.current.remove.mutateAsync('d1'))
    await flush()

    expect(harness.requests.at(-1)).toMatchObject({ method: 'DELETE', path: 'admin/domains/d1' })
    expect(result.current.list.data).toEqual([])
  })
})
