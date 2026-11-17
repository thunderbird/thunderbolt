/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'

export type LinkReviewDecision = 'approve' | 'reject'

/**
 * Approve or reject a review. A decision changes the queue, writes an audit event and, once the IdP
 * retries, a member's sources, so all three refresh.
 */
export const useLinkReviewDecision = ({ onDecided }: { onDecided: () => void }) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ reviewId, decision }: { reviewId: string; decision: LinkReviewDecision }) =>
      decision === 'approve' ? api.linkReviews.approve(reviewId) : api.linkReviews.reject(reviewId),
    onSuccess: async () => {
      await Promise.all(
        [adminQueryKeys.linkReviews.all, adminQueryKeys.auditEvents.all, adminQueryKeys.members.all].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      )
      onDecided()
    },
    // Another admin may have decided it, or it's gone: show the queue as it is now.
    onError: () => queryClient.invalidateQueries({ queryKey: adminQueryKeys.linkReviews.all }),
  })
}
