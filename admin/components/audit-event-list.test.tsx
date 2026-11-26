/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { makeAuditEvent } from '../screens/audit-log/audit-event-fixtures'
import { createAdminTestHarness, flush } from '../test-utils'
import { AuditEventList } from './audit-event-list'

const event = makeAuditEvent

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
    expect(screen.queryByText('Success')).not.toBeInTheDocument()
    const row = screen.getAllByRole('listitem').find((item) => within(item).queryByText('Member blocked'))
    expect(row && within(row).getAllByText('Person')).toHaveLength(2)
    expect(row && within(row).getAllByText('Person')[0]).toHaveAttribute('title', 'user u1')
    expect(screen.getByText('future_target').tagName).toBe('CODE')
  })

  it('names the actor and target, once when they are the same, with a readable client', async () => {
    const harness = createAdminTestHarness(() => ({
      body: {
        events: [
          event({
            action: 'local_group.created',
            targetType: 'local_group',
            targetId: 'g1',
            actorLabel: 'Ada',
            targetLabel: 'Ops',
          }),
          event({
            action: 'auth.sign_in',
            actorId: 'u1',
            targetId: 'u1',
            actorLabel: 'Grace',
            targetLabel: 'Grace',
            ipAddress: '203.0.113.7',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
          }),
        ],
        nextCursor: null,
      },
    }))
    render(<AuditEventList filters={{}} />, { wrapper: harness.wrapper })
    await flush()

    const [created, signIn] = screen.getAllByRole('listitem')
    expect(created).toHaveTextContent('Group created Ops by Ada')
    expect(within(signIn).getAllByText(/Grace/)).toHaveLength(1)
    expect(within(signIn).getByText('Firefox on macOS')).toHaveAttribute(
      'title',
      expect.stringContaining('Firefox/133.0'),
    )
    expect(within(signIn).getByText('203.0.113.7')).toBeInTheDocument()
  })

  it("shows a client it can't name by its raw user agent", async () => {
    const harness = createAdminTestHarness(() => ({
      body: { events: [event({ action: 'auth.sign_in', userAgent: 'curl/8.7.1' })], nextCursor: null },
    }))
    render(<AuditEventList filters={{}} />, { wrapper: harness.wrapper })
    await flush()

    expect(screen.getByText('curl/8.7.1')).toBeInTheDocument()
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

  it('says when nothing matches, or shows the empty state it is given', async () => {
    const harness = createAdminTestHarness(() => ({ body: { events: [], nextCursor: null } }))
    render(<AuditEventList filters={{}} />, { wrapper: harness.wrapper })
    await flush()
    expect(screen.getByText('No events.')).toBeInTheDocument()

    cleanup()
    render(<AuditEventList filters={{}} empty={<p>No sync errors.</p>} />, { wrapper: harness.wrapper })
    await flush()
    expect(screen.getByText('No sync errors.')).toBeInTheDocument()
  })

  it("doesn't open its rows unless asked, and with a selection opens them and marks the open one", async () => {
    const opened = event({ id: 'e1', actorLabel: 'Ada', targetLabel: 'Bob' })
    const harness = createAdminTestHarness(() => ({ body: { events: [opened], nextCursor: null } }))
    render(<AuditEventList filters={{}} />, { wrapper: harness.wrapper })
    await flush()
    expect(screen.queryByRole('button', { name: /^Open/ })).not.toBeInTheDocument()

    cleanup()
    const selected: string[] = []
    const { rerender } = render(
      <AuditEventList filters={{}} selection={{ selectedId: null, onSelect: (id) => selected.push(id) }} />,
      { wrapper: harness.wrapper },
    )
    await flush()
    const row = screen.getByRole('button', { name: 'Open Member blocked Bob by Ada' })
    expect(row).toHaveAttribute('aria-pressed', 'false')
    expect(row).toHaveTextContent('Member blocked Bob by Ada')

    fireEvent.click(row)
    expect(selected).toEqual(['e1'])
    rerender(<AuditEventList filters={{}} selection={{ selectedId: 'e1', onSelect: () => {} }} />)
    expect(screen.getByRole('button', { name: 'Open Member blocked Bob by Ada' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})
