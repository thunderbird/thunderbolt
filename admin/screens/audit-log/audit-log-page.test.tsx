/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, pickDate, type FakeRequest } from '../../test-utils'
import { makeAuditEvent } from './audit-event-fixtures'
import { AuditLogPage } from './audit-log-page'

const auditRequests = (requests: FakeRequest[]) => requests.filter((request) => request.path === 'admin/audit-events')

const renderPage = async (initialEntries?: string[], events = [makeAuditEvent()]) => {
  const harness = createAdminTestHarness(
    // A search matches none of the seeded events, as a term the server finds nowhere.
    ({ path, search }) =>
      path === 'admin/audit-events'
        ? { body: { events: search.get('q') ? [] : events, nextCursor: null } }
        : { body: { items: [] } },
    { initialEntries },
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

  it('shows the empty state with no search or filters in the header when the log is empty', async () => {
    const { requests } = await renderPage(undefined, [])

    expect(auditRequests(requests)).toHaveLength(1)
    expect(screen.getByText('No events yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument()
  })

  it('queries with the filters it writes to the URL', async () => {
    const { requests } = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    pickDate('From', '2026-11-01')
    await flush()

    const last = auditRequests(requests).at(-1)
    expect(last?.search.get('from')).toBe(new Date('2026-11-01T00:00:00').toISOString())
  })

  it('searches after the debounce, and a filter keeps the search', async () => {
    const { requests } = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search events'), { target: { value: ' okta ' } })
    await flush()
    await flush()

    expect(auditRequests(requests).at(-1)?.search.get('q')).toBe('okta')
    expect(screen.getByText('No matching events.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    pickDate('From', '2026-11-01')
    await flush()

    const last = auditRequests(requests).at(-1)
    expect(last?.search.get('q')).toBe('okta')
    expect(last?.search.get('from')).toBe(new Date('2026-11-01T00:00:00').toISOString())
  })

  it('opens with the search a link carries, which is not counted as a filter', async () => {
    const { requests } = await renderPage(['/admin/audit-log?q=ada'])

    expect(screen.getByPlaceholderText('Search events')).toHaveValue('ada')
    expect(auditRequests(requests).map((request) => request.search.get('q'))).toEqual(['ada'])
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('puts the filters button where the other screens\' "+" create action sits, after the search', async () => {
    await renderPage()

    const filters = screen.getByRole('button', { name: 'Filters' })
    // PageCreateAction's classes: -mr-2 undoes the header's pr-2, so the edge meets the list's.
    expect(filters).toHaveClass('-mr-2', 'border', 'bg-card')
    expect(screen.getByRole('button', { name: 'Search' }).nextElementSibling).toBe(filters)
  })

  it('opens a row in the panel, at once from the list, and marks the row while it is open', async () => {
    const blocked = makeAuditEvent({ id: 'e1', actorLabel: 'Ada', targetLabel: 'Bob' })
    const harness = createAdminTestHarness(({ path }) => {
      if (path === 'admin/audit-events') {
        return { body: { events: [blocked], nextCursor: null } }
      }
      return path === 'admin/audit-events/e1' ? { body: blocked } : { body: { items: [] } }
    })
    render(<AuditLogPage />, { wrapper: harness.wrapper })
    await flush()

    const row = screen.getByRole('button', { name: 'Open Member blocked Bob by Ada' })
    fireEvent.click(row)

    expect(screen.getByRole('heading', { name: 'Member blocked' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Bob' })).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-pressed', 'true')
    await flush()
    expect(harness.requests.some((request) => request.path === 'admin/audit-events/e1')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('heading', { name: 'Member blocked' })).not.toBeInTheDocument()
    expect(row).toHaveAttribute('aria-pressed', 'false')
  })
})
