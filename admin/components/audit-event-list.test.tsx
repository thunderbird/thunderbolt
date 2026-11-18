/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AuditEvent } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush } from '../test-utils'
import { AuditEventList } from './audit-event-list'

const event = (overrides: Partial<AuditEvent>): AuditEvent => ({
  id: crypto.randomUUID(),
  orgId: 'org',
  occurredAt: '2026-11-17T10:00:00.000Z',
  action: 'member.blocked',
  outcome: 'success',
  reason: null,
  actorType: 'user',
  actorId: 'admin-1',
  targetType: 'user',
  targetId: 'u1',
  connectionId: null,
  credentialId: null,
  requestId: null,
  reportSource: 'server',
  changes: null,
  metadata: null,
  ipAddress: null,
  userAgent: null,
  ...overrides,
})

describe('AuditEventList', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('labels known actions, shows unknown ones by id, and names the actor type', async () => {
    const harness = createAdminTestHarness(() => ({
      body: {
        events: [
          event({}),
          event({
            action: 'future.action',
            actorType: 'scim_connection',
            actorId: 'c1',
            outcome: 'failure',
            targetType: 'future_target',
            targetId: 't9',
          }),
        ],
        nextCursor: null,
      },
    }))
    render(<AuditEventList filters={{}} />, { wrapper: harness.wrapper })
    await flush()

    expect(screen.getByText('Member blocked')).toBeInTheDocument()
    expect(screen.getByText('future.action')).toBeInTheDocument()
    expect(screen.getByText('SCIM connection')).toBeInTheDocument()
    expect(screen.getByText('Failure')).toBeInTheDocument()
    const row = screen.getAllByRole('listitem').find((item) => within(item).queryByText('Member blocked'))
    expect(row && within(row).getByText('u1')).toBeInTheDocument()
    expect(row && within(row).getAllByText('Person')).toHaveLength(2)
    expect(screen.getByText('future_target').tagName).toBe('CODE')
  })

  it('passes the filters and pages with Load more', async () => {
    const harness = createAdminTestHarness(({ search }) =>
      search.get('cursor')
        ? { body: { events: [event({ action: 'domain.added' })], nextCursor: null } }
        : { body: { events: [event({})], nextCursor: 'next' } },
    )
    render(<AuditEventList filters={{ action: 'scim.request', outcome: 'failure', connectionId: 'c1' }} />, {
      wrapper: harness.wrapper,
    })
    await flush()

    const first = harness.requests[0]
    expect(first.path).toBe('admin/audit-events')
    expect(Object.fromEntries(first.search)).toEqual({ action: 'scim.request', outcome: 'failure', connectionId: 'c1' })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await flush()
    expect(screen.getByText('Domain added')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('says when nothing matches', async () => {
    const harness = createAdminTestHarness(() => ({ body: { events: [], nextCursor: null } }))
    render(<AuditEventList filters={{}} emptyMessage="No sync errors." />, { wrapper: harness.wrapper })
    await flush()
    expect(screen.getByText('No sync errors.')).toBeInTheDocument()
  })
})
