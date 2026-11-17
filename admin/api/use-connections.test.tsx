/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnection } from '@shared/admin-api'
import { renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush } from '../test-utils'
import { useConnections } from './use-connections'

const okta: AdminConnection = {
  id: 'c1',
  name: 'Okta',
  status: 'active',
  matchClaim: 'email',
  sso: { providerId: 'okta', protocol: 'oidc', issuer: 'https://okta.test', envOwned: false },
  scim: null,
  claimedDomains: [],
  createdAt: '2026-11-17T00:00:00.000Z',
}
const connections = [okta, { ...okta, id: 'c2', status: 'retired' as const }]

describe('useConnections', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('reads the list once for every caller, and derives views with select', async () => {
    const harness = createAdminTestHarness(() => ({ body: { items: connections } }))
    const { result } = renderHook(
      () => ({
        all: useConnections(),
        active: useConnections((items) => items.filter((connection) => connection.status === 'active')),
      }),
      { wrapper: harness.wrapper },
    )
    await flush()
    expect(result.current.all.data).toEqual(connections)
    expect(result.current.active.data?.map((connection) => connection.id)).toEqual(['c1'])
    expect(harness.requests.filter((request) => request.path === 'admin/connections')).toHaveLength(1)
  })
})
