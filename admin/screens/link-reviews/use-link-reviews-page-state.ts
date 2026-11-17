/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useSearchParams } from 'react-router'
import type { LinkReviewStatus } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useConnections } from '../../api/use-connections'
import { useCursorList } from '../../api/use-cursor-list'
import { useResourcePageState } from '../../components/use-resource-page-state'

export const linkReviewStatuses: LinkReviewStatus[] = ['pending', 'approved', 'rejected', 'linked']

const isStatus = (value: string | null): value is LinkReviewStatus =>
  (linkReviewStatuses as (string | null)[]).includes(value)

/**
 * The review queue: its status and connection filters (in the URL, as `?status=` and `?connection=`),
 * the paged list, and the open review.
 */
export const useLinkReviewsPageState = () => {
  const api = useAdminApi()
  const page = useResourcePageState()
  const [params, setParams] = useSearchParams()
  const requestedStatus = params.get('status')
  const status = isStatus(requestedStatus) ? requestedStatus : 'pending'
  const connectionId = params.get('connection') ?? undefined

  const setParam = (name: string, value: string | undefined) =>
    setParams((current) => {
      const next = new URLSearchParams(current)
      if (value === undefined) {
        next.delete(name)
      } else {
        next.set(name, value)
      }
      return next
    })
  const query = { status, connectionId }
  const reviews = useCursorList({
    queryKey: adminQueryKeys.linkReviews.list(query),
    fetchPage: (cursor) => api.linkReviews.list({ ...query, cursor }),
  })
  const connections = useConnections()

  return {
    page,
    status,
    setStatus: (value: LinkReviewStatus) => setParam('status', value === 'pending' ? undefined : value),
    connectionId,
    setConnectionId: (value: string | undefined) => setParam('connection', value),
    reviews,
    connections: connections.data ?? [],
    selected: reviews.items.find((review) => review.id === page.selectedId) ?? null,
  }
}
