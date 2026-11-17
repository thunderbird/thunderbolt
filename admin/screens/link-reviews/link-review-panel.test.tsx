/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { LinkReview } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { linkReview } from './fixtures'
import { LinkReviewPanel } from './link-review-panel'

const adminRequests = (requests: FakeRequest[]) => requests.filter((request) => request.path.startsWith('admin/'))

const renderPanel = async (review: LinkReview, reply: FakeReply = { body: review }) => {
  const harness = createAdminTestHarness(() => reply)
  const onDecided = mock(() => {})
  render(<LinkReviewPanel review={review} onClose={() => {}} onDecided={onDecided} />, { wrapper: harness.wrapper })
  await flush()
  return { harness, onDecided }
}

describe('LinkReviewPanel', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('shows both identities', async () => {
    await renderPanel(linkReview({ attempts: 3 }))

    const incoming = screen.getByRole('region', { name: 'Incoming identity' })
    expect(within(incoming).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(incoming).getByText('sub-1').tagName).toBe('CODE')
    expect(within(incoming).getByText('Okta')).toBeInTheDocument()
    expect(within(incoming).getByText('SSO sign-in')).toBeInTheDocument()
    expect(within(incoming).getByText('3 attempts')).toBeInTheDocument()
    const existing = screen.getByRole('region', { name: 'Existing account' })
    expect(within(existing).getByText('ada.l@example.com')).toBeInTheDocument()
    expect(within(existing).getByText('Ada L.')).toBeInTheDocument()
  })

  it('approves after confirmation and refreshes the queue, the audit log and members', async () => {
    const review = linkReview()
    const { harness, onDecided } = await renderPanel(review)
    const invalidate = mock(harness.queryClient.invalidateQueries.bind(harness.queryClient))
    harness.queryClient.invalidateQueries = invalidate

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent(
      'ada@example.com (subject sub-1) from Okta will be linked to the existing account ada.l@example.com',
    )
    expect(adminRequests(harness.requests)).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
    await flush()

    expect(adminRequests(harness.requests).map((request) => [request.method, request.path])).toEqual([
      ['POST', `admin/link-reviews/${review.id}/approve`],
    ])
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      adminQueryKeys.linkReviews.all,
      adminQueryKeys.auditEvents.all,
      adminQueryKeys.members.all,
    ])
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('rejects after confirmation', async () => {
    const review = linkReview()
    const { harness, onDecided } = await renderPanel(review)

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('is refused until an admin approves the link')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))
    await flush()

    expect(adminRequests(harness.requests).map((request) => request.path)).toEqual([
      `admin/link-reviews/${review.id}/reject`,
    ])
    expect(onDecided).toHaveBeenCalledTimes(1)
  })

  it('keeps the dialog open with the reason when the decision fails, and refreshes the queue', async () => {
    const { harness, onDecided } = await renderPanel(linkReview(), {
      status: 409,
      body: { code: 'LINK_REVIEW_RESOLVED' },
    })
    const invalidate = mock(harness.queryClient.invalidateQueries.bind(harness.queryClient))
    harness.queryClient.invalidateQueries = invalidate

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }))
    await flush()

    expect(within(screen.getByRole('alertdialog')).getByRole('alert')).toHaveTextContent(
      'Someone has already decided this review.',
    )
    expect(onDecided).not.toHaveBeenCalled()
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([adminQueryKeys.linkReviews.all])
  })

  it("can't approve a link to the admin's own account", async () => {
    await renderPanel(linkReview({ candidateUserId: 'admin-1' }))

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByText('This is your own account, so another admin has to approve the link.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('offers only Approve on a rejected review, and nothing once approved or linked', async () => {
    await renderPanel(linkReview({ status: 'rejected', resolvedAt: '2026-11-17T11:00:00.000Z' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    expect(screen.getByText(/^Decided/)).toBeInTheDocument()
    cleanup()

    for (const status of ['approved', 'linked'] as const) {
      await renderPanel(linkReview({ status }))
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
      cleanup()
    }
  })
})
