/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AuditEvent } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush } from '../../test-utils'
import { makeAuditEvent } from './audit-event-fixtures'
import { AuditEventPanel } from './audit-event-panel'

const firefoxOnMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0'

/** The panel for `event`, served by the backend; any other read answers not found. */
const renderPanel = async (event: AuditEvent | null) => {
  const harness = createAdminTestHarness(({ path }) => {
    if (path === 'admin/connections') {
      return { body: { items: [{ id: 'okta', name: 'Okta' }] } }
    }
    return event && path === `admin/audit-events/${event.id}`
      ? { body: event }
      : { status: 404, body: { code: 'AUDIT_EVENT_NOT_FOUND' } }
  })
  render(<AuditEventPanel eventId={event?.id ?? 'missing'} onClose={() => {}} />, { wrapper: harness.wrapper })
  await flush()
  return harness
}

describe('AuditEventPanel', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('titles the event with its action and shows how it went, who did it to what, and from where', async () => {
    await renderPanel(
      makeAuditEvent({
        id: 'e1',
        action: 'local_group.updated',
        outcome: 'denied',
        reason: 'not_allowed',
        actorId: 'u1',
        actorLabel: 'Ada',
        targetType: 'local_group',
        targetId: 'g1',
        targetLabel: 'Ops',
        connectionId: 'okta',
        userAgent: firefoxOnMac,
        ipAddress: '203.0.113.7',
        requestId: 'req-1',
      }),
    )

    expect(screen.getByRole('heading', { name: 'Group updated' })).toBeInTheDocument()
    expect(screen.getByText('Denied')).toBeInTheDocument()
    expect(screen.getByText('not_allowed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ada' })).toHaveAttribute('href', '/admin/members')
    expect(screen.getByText('u1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ops' })).toHaveAttribute('href', '/admin/groups')
    expect(screen.getByText('g1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Okta' })).toHaveAttribute('href', '/admin/sign-in-methods')
    expect(screen.getByText('Firefox on macOS')).toBeInTheDocument()
    expect(screen.getByText(firefoxOnMac)).toBeInTheDocument()
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument()
    expect(screen.getByText('req-1')).toBeInTheDocument()
    expect(screen.getByRole('time')).toHaveAttribute('datetime', '2026-11-17T10:00:00.000Z')
    // Read-only, with nothing to do to an event: no ⋯ menu.
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
  })

  it("doesn't link an actor or target the server couldn't name, and names it by its type", async () => {
    await renderPanel(
      makeAuditEvent({ id: 'e1', actorType: 'system', actorId: null, targetType: 'future_target', targetId: 't9' }),
    )

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    expect(screen.getByText('future_target')).toBeInTheDocument()
    expect(screen.getByText('t9')).toBeInTheDocument()
  })

  it('names the API key the actor acted through, by its id once the key is gone', async () => {
    await renderPanel(makeAuditEvent({ id: 'e1', metadata: { apiKeyId: 'key-1' }, apiKeyLabel: 'Deploy bot' }))
    expect(screen.getByText('Through API key Deploy bot')).toBeInTheDocument()

    cleanup()
    await renderPanel(makeAuditEvent({ id: 'e2', metadata: { apiKeyId: 'key-1' } }))
    expect(screen.getByText('Through API key key-1')).toBeInTheDocument()
  })

  it('says nothing of an API key for an event made without one', async () => {
    await renderPanel(makeAuditEvent({ id: 'e1', metadata: { domain: 'example.com' } }))

    expect(screen.queryByText(/Through API key/)).not.toBeInTheDocument()
  })

  it('shows what changed field by field, and the details by key, with unshaped data as JSON', async () => {
    await renderPanel(
      makeAuditEvent({
        id: 'e1',
        changes: { enrollmentEnabled: { from: false, to: true } },
        metadata: { domain: 'example.com', roles: ['admin'] },
      }),
    )

    expect(screen.getByText('enrollmentEnabled')).toBeInTheDocument()
    expect(screen.getByText('false → true')).toBeInTheDocument()
    expect(screen.getByText('domain')).toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText('["admin"]')).toBeInTheDocument()

    cleanup()
    await renderPanel(makeAuditEvent({ id: 'e2', metadata: ['raw'] }))
    expect(screen.getByText(/"raw"/).closest('pre')).toBeInTheDocument()
  })

  it("says the event isn't there when the server can't find it", async () => {
    await renderPanel(null)

    expect(screen.getByRole('heading', { name: 'Event' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent("This event isn't in your organization's audit log.")
  })
})
