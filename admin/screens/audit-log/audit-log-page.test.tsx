/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeRequest } from '../../test-utils'
import { AuditLogPage } from './audit-log-page'

const auditRequests = (requests: FakeRequest[]) => requests.filter((request) => request.path === 'admin/audit-events')

const renderPage = async () => {
  const harness = createAdminTestHarness(({ path }) =>
    path === 'admin/audit-events' ? { body: { events: [], nextCursor: null } } : { body: { items: [] } },
  )
  render(<AuditLogPage />, { wrapper: harness.wrapper })
  await flush()
  return harness
}

describe('AuditLogPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('lists the events, and says so when none match', async () => {
    const { requests } = await renderPage()

    expect(auditRequests(requests)).toHaveLength(1)
    expect(screen.getByText('No events match these filters.')).toBeInTheDocument()
  })

  it('fetches the events again on Refresh', async () => {
    const { requests } = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await flush()

    expect(auditRequests(requests)).toHaveLength(2)
  })

  it('queries with the filters it writes to the URL', async () => {
    const { requests } = await renderPage()

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } })
    await flush()

    const last = auditRequests(requests).at(-1)
    expect(last?.search.get('from')).toBe(new Date('2026-11-01T00:00:00').toISOString())
  })
})
