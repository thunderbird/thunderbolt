/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQuery } from '@tanstack/react-query'
import { adminPageMaxSize, type ListLinkReviewsQuery } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'

// There's no count endpoint: one full page means "100 or more", which the badge shows as 99+.
const pendingQuery: ListLinkReviewsQuery = { status: 'pending', limit: adminPageMaxSize }

/** The sidebar badge on Link reviews: how many reviews wait, or null until known. */
export const usePendingLinkReviewCount = (): number | null => {
  const api = useAdminApi()
  const { data } = useQuery({
    queryKey: adminQueryKeys.linkReviews.list(pendingQuery),
    queryFn: () => api.linkReviews.list(pendingQuery),
  })
  return data ? data.items.length : null
}
