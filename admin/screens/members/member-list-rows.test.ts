/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it, mock } from 'bun:test'
import type { Invitation } from '@shared/admin-api'
import { linkReview } from './link-review-fixtures'
import { makeMember } from './member-fixtures'
import { chainSegments, invitationRows, memberRows, reviewRows, withoutIds, type ListSegment } from './member-list-rows'

const invitation = (id: string): Invitation => ({
  id,
  email: `${id}@example.com`,
  status: 'pending',
  expiresAt: '2026-12-01T00:00:00.000Z',
  idpOverride: false,
  invitedBy: null,
  createdAt: '2026-11-24T00:00:00.000Z',
})

const segment = (keys: string[], hasMore = false): ListSegment => ({
  rows: memberRows(keys.map((userId) => makeMember({ userId }))),
  list: { hasMore, isLoadingMore: false, loadMore: mock(() => {}) },
})

describe('chainSegments', () => {
  it('runs every segment in order when all are loaded, with nothing more to load', () => {
    const chain = chainSegments([segment(['a']), segment(['b', 'c']), segment([])])

    expect(chain.rows.map((row) => row.key)).toEqual(['a', 'b', 'c'])
    expect(chain.hasMore).toBe(false)
  })

  it('stops after the first segment with pages left, and loads more of that one', () => {
    const first = segment(['a'])
    const open = segment(['b'], true)
    const later = segment(['c'], true)
    const chain = chainSegments([first, open, later])

    expect(chain.rows.map((row) => row.key)).toEqual(['a', 'b'])
    expect(chain.hasMore).toBe(true)
    chain.loadMore()
    expect(open.list.loadMore).toHaveBeenCalledTimes(1)
    expect(later.list.loadMore).not.toHaveBeenCalled()
  })

  it("reports the open segment's next page loading", () => {
    const open = { ...segment(['a'], true), list: { hasMore: true, isLoadingMore: true, loadMore: () => {} } }
    expect(chainSegments([segment([]), open]).isLoadingMore).toBe(true)
  })
})

describe('row keys', () => {
  it('are the selection ids, so the three kinds never collide', () => {
    const keys = [
      ...reviewRows([linkReview({ id: 'x' })]),
      ...invitationRows([invitation('x')]),
      ...memberRows([makeMember({ userId: 'x' })]),
    ].map((row) => row.key)
    expect(keys).toEqual(['link:x', 'invite:x', 'x'])
  })
})

describe('withoutIds', () => {
  it('drops the items any newer list also holds, keeping the order', () => {
    const items = [invitation('a'), invitation('b'), invitation('c')]
    expect(withoutIds(items, [invitation('b')], [invitation('c')]).map((item) => item.id)).toEqual(['a'])
    expect(withoutIds(items).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})
