/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AuditEventQuery } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createAdminTestHarness, flush, pickDate, type FakeRequest } from '../../test-utils'
import { toRangeEnd, toRangeStart } from './audit-date-range'
import { AuditLogFilterChips, AuditLogFiltersButton } from './audit-log-filters'

const respond = ({ path, search }: FakeRequest) => {
  if (path === 'admin/connections') {
    return { body: { items: [{ id: 'c1', name: 'Okta' }] } }
  }
  if (path === 'admin/members') {
    const all = [
      { userId: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' },
      { userId: 'u2', name: '', email: 'grace@example.com' },
    ]
    const q = search.get('q') ?? ''
    return { body: { items: all.filter((member) => member.email.includes(q)), nextCursor: null } }
  }
  if (path === 'admin/members/u1') {
    return { body: { userId: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' } }
  }
  if (path.startsWith('admin/members/')) {
    return { status: 404, body: { code: 'MEMBER_NOT_FOUND' } }
  }
  return {}
}

const renderFilters = async (filters: AuditEventQuery = {}) => {
  const harness = createAdminTestHarness(respond)
  const onChange = mock((_: AuditEventQuery) => {})
  render(
    <>
      <AuditLogFiltersButton filters={filters} onChange={onChange} />
      <AuditLogFilterChips filters={filters} onChange={onChange} />
    </>,
    { wrapper: harness.wrapper },
  )
  await flush()
  return { onChange, requests: harness.requests }
}

const openFilters = () => fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))

const pick = (trigger: string, option: string) => {
  const select = screen.getByRole('combobox', { name: trigger })
  fireEvent.pointerDown(select, { button: 0, pointerId: 1 })
  fireEvent.click(select)
  const item = screen.getByRole('option', { name: option })
  fireEvent.pointerUp(item, { button: 0, pointerId: 1 })
  fireEvent.click(item)
}

describe('AuditLogFiltersButton and AuditLogFilterChips', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('filters by a labelled action and keeps the other filters', async () => {
    const { onChange } = await renderFilters({ outcome: 'denied' })
    openFilters()

    pick('Action', 'Group created')

    expect(onChange).toHaveBeenLastCalledWith({ outcome: 'denied', action: 'local_group.created' })
  })

  it('filters by outcome, target type and connection, and back to any', async () => {
    const { onChange } = await renderFilters({ connectionId: 'c1' })
    openFilters()

    pick('Outcome', 'Failure')
    expect(onChange).toHaveBeenLastCalledWith({ connectionId: 'c1', outcome: 'failure' })
    pick('Target type', 'Group')
    expect(onChange).toHaveBeenLastCalledWith({ connectionId: 'c1', targetType: 'local_group' })
    pick('Connection', 'Any connection')
    expect(onChange).toHaveBeenLastCalledWith({ connectionId: undefined })
  })

  it('keeps an unknown connection from a link selectable by its id', async () => {
    await renderFilters({ connectionId: 'gone' })
    openFilters()

    expect(screen.getByRole('combobox', { name: 'Connection' })).toHaveTextContent('gone')
  })

  it('bounds the date range by whole local days', async () => {
    const { onChange } = await renderFilters()
    openFilters()

    pickDate('From', '2026-11-01')
    expect(onChange).toHaveBeenLastCalledWith({ from: toRangeStart('2026-11-01') })
    pickDate('To', '2026-11-17')
    expect(onChange).toHaveBeenLastCalledWith({ to: toRangeEnd('2026-11-17') })
  })

  it('shows the dates a link carries', async () => {
    await renderFilters({ from: toRangeStart('2026-11-01'), to: toRangeEnd('2026-11-17') })
    expect(screen.getByText('From: Nov 1, 2026')).toBeInTheDocument()
    expect(screen.getByText('To: Nov 17, 2026')).toBeInTheDocument()
    openFilters()

    expect(screen.getByLabelText('From')).toHaveTextContent('Nov 1, 2026')
    expect(screen.getByLabelText('To')).toHaveTextContent('Nov 17, 2026')
  })

  it("picks a member as the actor by searching the server's member list", async () => {
    const { onChange, requests } = await renderFilters()
    openFilters()

    fireEvent.click(screen.getByRole('combobox', { name: 'Actor' }))
    fireEvent.change(screen.getByPlaceholderText('Search by name or email'), { target: { value: 'grace' } })
    await flush()
    await flush()

    expect(requests.some((request) => request.path === 'admin/members' && request.search.get('q') === 'grace')).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('option', { name: 'grace@example.com' }))
    expect(onChange).toHaveBeenLastCalledWith({ actorId: 'u2' })
  })

  it('shows an actor from a link by its id', async () => {
    await renderFilters({ actorId: 'key-123' })
    openFilters()

    expect(screen.getByRole('combobox', { name: 'Actor' })).toHaveTextContent('key-123')
  })

  it('shows each set filter as a chip, with the names it can find, and counts them on the button', async () => {
    const { onChange } = await renderFilters({
      action: 'local_group.created',
      outcome: 'denied',
      actorId: 'u1',
      connectionId: 'c1',
    })

    expect(screen.getByRole('button', { name: 'Filters (4)' })).toBeInTheDocument()
    expect(screen.getByText('Action: Group created')).toBeInTheDocument()
    expect(screen.getByText('Outcome: Denied')).toBeInTheDocument()
    expect(screen.getByText('Actor: Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Connection: Okta')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove the outcome filter' }))
    expect(onChange).toHaveBeenLastCalledWith({
      action: 'local_group.created',
      outcome: undefined,
      actorId: 'u1',
      connectionId: 'c1',
    })
  })

  it("shows a link's target as a chip that removes it", async () => {
    const { onChange } = await renderFilters({ targetType: 'user', targetId: 'u9' })

    expect(screen.getByText('u9')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove the target filter' }))
    expect(onChange).toHaveBeenLastCalledWith({ targetType: 'user', targetId: undefined })
  })

  it('clears every filter, and offers it only when one is set', async () => {
    const { onChange } = await renderFilters({ action: 'member.blocked', actorId: 'u1' })

    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onChange).toHaveBeenLastCalledWith({})

    cleanup()
    await renderFilters()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
  })
})
