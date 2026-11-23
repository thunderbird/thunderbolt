/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { useCursorList } from '../../api/use-cursor-list'
import { useAdminApi } from '../../api/use-admin-api'
import { createAdminTestHarness, flush, type FakeReply } from '../../test-utils'
import { linkReview } from './link-review-fixtures'
import { usePendingLinkReviewCount } from './use-pending-link-review-count'

const page = (count: number, nextCursor: string | null = null): FakeReply => ({
  body: { reviews: Array.from({ length: count }, () => linkReview()), nextCursor },
})

const renderCount = async (reply: FakeReply) => {
  const harness = createAdminTestHarness(() => reply)
  const { result } = renderHook(usePendingLinkReviewCount, { wrapper: harness.wrapper })
  return { result, harness }
}

describe('usePendingLinkReviewCount', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('is null until the queue answers, then counts the pending reviews', async () => {
    const { result, harness } = await renderCount(page(3))
    expect(result.current).toBeNull()
    await flush()

    expect(result.current).toBe(3)
    expect(harness.requests[0].search.get('status')).toBe('pending')
    expect(harness.requests[0].search.get('limit')).toBe('100')
  })

  it('is 0 for an empty queue, which hides the badge', async () => {
    const { result } = await renderCount(page(0))
    await flush()
    expect(result.current).toBe(0)
  })

  it('is 100 for a full page, which the badge shows as 99+', async () => {
    const { result } = await renderCount(page(100, 'more'))
    await flush()
    expect(result.current).toBe(100)
  })

  it('stays null when the queue fails', async () => {
    const { result } = await renderCount({ status: 500, body: {} })
    await flush()
    expect(result.current).toBeNull()
  })

  it("doesn't share a cache entry with the queue's paged list", async () => {
    const harness = createAdminTestHarness(() => page(2))
    const { result } = renderHook(
      () => {
        const api = useAdminApi()
        const query = { status: 'pending' as const }
        const queue = useCursorList({
          queryKey: adminQueryKeys.linkReviews.list(query),
          fetchPage: (cursor) => api.linkReviews.list({ ...query, cursor }),
        })
        return { badge: usePendingLinkReviewCount(), queue: queue.items.length }
      },
      { wrapper: harness.wrapper },
    )
    await flush()

    expect(result.current).toEqual({ badge: 2, queue: 2 })
    const keys = harness.queryClient
      .getQueryCache()
      .findAll({ queryKey: adminQueryKeys.linkReviews.all })
      .map((query) => query.queryKey)
    expect(keys).toHaveLength(2)
  })
})
