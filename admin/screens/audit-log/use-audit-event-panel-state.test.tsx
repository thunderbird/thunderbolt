/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { AdminApiError } from '../../api/client'
import { createAdminTestHarness, flush, type FakeRequest } from '../../test-utils'
import { makeAuditEvent } from './audit-event-fixtures'
import { useAuditEventPanelState } from './use-audit-event-panel-state'

const listed = makeAuditEvent({ id: 'e1', actorLabel: 'Ada' })

/** The event `e1`, read back with a newer label; any other id is another org's or unknown. */
const backend = ({ path }: FakeRequest) => {
  if (path === 'admin/connections') {
    return { body: { items: [{ id: 'okta', name: 'Okta' }] } }
  }
  return path === 'admin/audit-events/e1'
    ? { body: { ...listed, actorLabel: 'Ada Lovelace' } }
    : { status: 404, body: { code: 'AUDIT_EVENT_NOT_FOUND' } }
}

describe('useAuditEventPanelState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('opens on the event a loaded page of the log holds, then reads it', async () => {
    const harness = createAdminTestHarness(backend)
    harness.queryClient.setQueryData([...adminQueryKeys.auditEvents.list({ action: 'member.blocked' }), 'pages'], {
      pages: [{ items: [listed], nextCursor: null }],
      pageParams: [undefined],
    })
    const { result } = renderHook(() => useAuditEventPanelState('e1'), { wrapper: harness.wrapper })

    expect(result.current.event.data?.actorLabel).toBe('Ada')
    expect(result.current.event.isPlaceholderData).toBe(true)
    await flush()

    expect(result.current.event.data?.actorLabel).toBe('Ada Lovelace')
    expect(harness.requests.map((request) => request.path)).toContain('admin/audit-events/e1')
  })

  it("names the event's connection from the connections list", async () => {
    const harness = createAdminTestHarness(({ path }) =>
      path === 'admin/connections'
        ? { body: { items: [{ id: 'okta', name: 'Okta' }] } }
        : { body: makeAuditEvent({ id: 'e2', connectionId: 'okta' }) },
    )
    const { result } = renderHook(() => useAuditEventPanelState('e2'), { wrapper: harness.wrapper })
    await flush()

    expect(result.current.connectionName).toBe('Okta')
  })

  it("has no event, and the server's not-found error, for one that isn't in the cache or the org", async () => {
    const harness = createAdminTestHarness(backend)
    const { result } = renderHook(() => useAuditEventPanelState('elsewhere'), { wrapper: harness.wrapper })
    await flush()

    expect(result.current.event.data).toBeUndefined()
    expect(result.current.event.error).toBeInstanceOf(AdminApiError)
    expect((result.current.event.error as AdminApiError).code).toBe('AUDIT_EVENT_NOT_FOUND')
  })
})
