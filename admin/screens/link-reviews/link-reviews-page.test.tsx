/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { linkReview } from './fixtures'
import { LinkReviewsPage } from './link-reviews-page'

const reviewRequests = (requests: FakeRequest[]) => requests.filter((request) => request.path === 'admin/link-reviews')

const renderPage = async (reviews: (request: FakeRequest) => FakeReply) => {
  const harness = createAdminTestHarness((request) =>
    request.path === 'admin/connections' ? { body: { items: [{ id: 'c1', name: 'Okta' }] } } : reviews(request),
  )
  render(<LinkReviewsPage />, { wrapper: harness.wrapper })
  await flush()
  return harness
}

const pick = (trigger: string, option: string) => {
  const select = screen.getByRole('combobox', { name: trigger })
  fireEvent.pointerDown(select, { button: 0, pointerId: 1 })
  fireEvent.click(select)
  const item = screen.getByRole('option', { name: option })
  fireEvent.pointerUp(item, { button: 0, pointerId: 1 })
  fireEvent.click(item)
}

describe('LinkReviewsPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('lists the pending reviews first, and opens one', async () => {
    await renderPage(() => ({ body: { reviews: [linkReview({ attempts: 2 })], nextCursor: null } }))

    expect(screen.getByRole('radio', { name: 'Pending' })).toHaveAttribute('data-state', 'on')
    expect(screen.getByText('2 attempts')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'ada@example.com' }))
    await flush()

    expect(screen.getByRole('region', { name: 'Existing account' })).toBeInTheDocument()
  })

  it('filters by status and identity provider', async () => {
    const harness = await renderPage(() => ({ body: { reviews: [], nextCursor: null } }))
    expect(reviewRequests(harness.requests)[0].search.get('status')).toBe('pending')

    fireEvent.click(screen.getByRole('radio', { name: 'Rejected' }))
    await flush()
    pick('Identity provider', 'Okta')
    await flush()

    const last = reviewRequests(harness.requests).at(-1)
    expect(last?.search.get('status')).toBe('rejected')
    expect(last?.search.get('connectionId')).toBe('c1')
  })

  it('keeps the filters while a review opens and closes', async () => {
    const harness = await renderPage(() => ({
      body: { reviews: [linkReview({ status: 'rejected' })], nextCursor: null },
    }))

    fireEvent.click(screen.getByRole('radio', { name: 'Rejected' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'ada@example.com' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'ada@example.com' }))
    await flush()

    expect(screen.getByRole('radio', { name: 'Rejected' })).toHaveAttribute('data-state', 'on')
    expect(
      reviewRequests(harness.requests).every(
        (request, index) => index === 0 || request.search.get('status') === 'rejected',
      ),
    ).toBe(true)
  })

  it('says when nothing is waiting', async () => {
    await renderPage(() => ({ body: { reviews: [], nextCursor: null } }))
    expect(screen.getByText('No links are waiting for review.')).toBeInTheDocument()
  })

  it('shows the error when the queue fails', async () => {
    await renderPage(() => ({ status: 403, body: { code: 'ADMIN_REQUIRED' } }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('loads the next page', async () => {
    await renderPage(({ search }) =>
      search.get('cursor')
        ? { body: { reviews: [linkReview({ incomingEmail: 'grace@example.com' })], nextCursor: null } }
        : { body: { reviews: [linkReview()], nextCursor: 'next' } },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await flush()

    expect(screen.getByRole('button', { name: 'grace@example.com' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })
})
