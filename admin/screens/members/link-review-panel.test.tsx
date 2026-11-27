/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { LinkReview } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { linkReviewActions } from './member-actions'
import { linkReview } from './link-review-fixtures'
import { LinkReviewConfirmDialog } from './link-review-confirm-dialog'
import { LinkReviewPanel } from './link-review-panel'
import { useLinkReviewDecision } from './use-link-review-decision'

const adminRequests = (requests: FakeRequest[]) => requests.filter((request) => request.path.startsWith('admin/'))

const renderPanel = (review: LinkReview, { selfId = 'admin-1' }: { selfId?: string } = {}) => {
  const harness = createAdminTestHarness(() => ({ body: review }))
  const onDecide = mock()
  render(
    <LinkReviewPanel
      review={review}
      isOwnAccount={review.candidateUserId === selfId}
      actions={linkReviewActions(review, { selfId, onDecide })}
      onClose={() => {}}
    />,
    { wrapper: harness.wrapper },
  )
  return { harness, onDecide }
}

const menuItems = async () => {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
  return screen.findAllByRole('menuitem')
}

describe('LinkReviewPanel', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('shows both identities, read-only', () => {
    renderPanel(linkReview({ attempts: 3 }))

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('sub-1').tagName).toBe('CODE')
    expect(screen.getByText('Okta')).toBeInTheDocument()
    expect(screen.getByText('SSO sign-in')).toBeInTheDocument()
    expect(screen.getByText('3 attempts')).toBeInTheDocument()
    expect(screen.getByText('ada.l@example.com')).toBeInTheDocument()
    expect(screen.getByText('Ada L.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('offers Approve and Reject in its menu while pending', async () => {
    const { onDecide } = renderPanel(linkReview())

    expect((await menuItems()).map((item) => item.textContent)).toEqual(['Approve', 'Reject'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith('approve')
  })

  it("can't approve a link to the admin's own account, and says why", async () => {
    renderPanel(linkReview({ candidateUserId: 'admin-1' }))

    expect(screen.getByText('Another admin has to approve your own link.')).toBeInTheDocument()
    await menuItems()
    expect(screen.getByRole('menuitem', { name: 'Approve' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('offers only Approve on a rejected review, and nothing once approved', async () => {
    renderPanel(linkReview({ status: 'rejected', resolvedAt: '2026-11-18T00:00:00.000Z' }))
    expect((await menuItems()).map((item) => item.textContent)).toEqual(['Approve'])
    cleanup()

    renderPanel(linkReview({ status: 'approved', resolvedAt: '2026-11-18T00:00:00.000Z' }))
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })
})

describe('Deciding a link review', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  const renderDecision = (review: LinkReview, decision: 'approve' | 'reject', reply: FakeReply = { body: review }) => {
    const harness = createAdminTestHarness(() => reply)
    const onDecided = mock()
    const { result } = renderHook(() => useLinkReviewDecision({ onDecided }), { wrapper: harness.wrapper })
    const view = () =>
      render(
        <LinkReviewConfirmDialog
          review={review}
          decision={decision}
          isPending={result.current.isPending}
          error={result.current.error}
          onConfirm={(choice) => result.current.mutate({ reviewId: review.id, decision: choice })}
          onCancel={() => {}}
        />,
        { wrapper: harness.wrapper },
      )
    return { harness, onDecided, result, view }
  }

  it('approves after confirmation, naming both accounts, and refreshes the queue, the audit log and members', async () => {
    const review = linkReview()
    const { harness, onDecided, view } = renderDecision(review, 'approve')
    const invalidate = mock(harness.queryClient.invalidateQueries.bind(harness.queryClient))
    harness.queryClient.invalidateQueries = invalidate
    view()

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Link ada@example.com to ada.l@example.com?')
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
    const { harness, view } = renderDecision(review, 'reject')
    view()

    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('until an admin approves the link')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))
    await flush()
    expect(adminRequests(harness.requests).map((request) => request.path)).toEqual([
      `admin/link-reviews/${review.id}/reject`,
    ])
  })

  it('refreshes the queue when the decision fails', async () => {
    const review = linkReview()
    const { harness, onDecided, result } = renderDecision(review, 'approve', {
      status: 409,
      body: { code: 'LINK_REVIEW_RESOLVED' },
    })
    const invalidate = mock(harness.queryClient.invalidateQueries.bind(harness.queryClient))
    harness.queryClient.invalidateQueries = invalidate

    act(() => result.current.mutate({ reviewId: review.id, decision: 'approve' }))
    await flush()

    expect(result.current.error).not.toBeNull()
    expect(onDecided).not.toHaveBeenCalled()
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([adminQueryKeys.linkReviews.all])
  })
})
