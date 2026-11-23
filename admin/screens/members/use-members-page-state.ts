/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  adminPageMaxSize,
  type AdminMember,
  type Invitation,
  type InvitationStatus,
  type LinkReview,
} from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'
import { useResourcePageState } from '../../components/use-resource-page-state'
import { parseInvitationEditId } from './invitation-rules'
import { parseLinkReviewEditId } from './link-review-rules'

/** One status of invitations, searched with the members. */
const useInvitationList = (status: InvitationStatus, q: string | undefined, enabled = true) => {
  const api = useAdminApi()
  return useCursorList<Invitation>({
    queryKey: adminQueryKeys.invitations.list(status, q),
    fetchPage: (cursor) => api.invitations.list({ status, q, cursor, limit: adminPageMaxSize }),
    enabled,
  })
}

/** One status of link reviews. Search doesn't narrow them: the API has no search for reviews. */
const useLinkReviewList = (status: 'pending' | 'rejected', enabled = true) => {
  const api = useAdminApi()
  return useCursorList<LinkReview>({
    queryKey: adminQueryKeys.linkReviews.list({ status }),
    fetchPage: (cursor) => api.linkReviews.list({ status, cursor }),
    enabled,
  })
}

/**
 * The members list and the pending invitations above it, both searched on the server; revoked
 * invitations on request (`?revoked=1`); the identities waiting for an admin to link them, and the
 * rejected ones on request (`?rejected=1`), since approving is how a rejection is undone; the selected member, invitation (`?edit=invite:<id>`), link review
 * (`?edit=link:<id>`) or invite form (`?edit=new`); and whether any admin can sign in without the IdP.
 */
export const useMembersPageState = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const page = useResourcePageState()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<{ kind: 'invited' | 'revoked'; email: string } | null>(null)
  const q = useDeferredValue(search.trim()) || undefined
  const showRevoked = params.get('revoked') === '1'
  const showRejected = params.get('rejected') === '1'

  const list = useCursorList<AdminMember>({
    queryKey: adminQueryKeys.members.list(q),
    fetchPage: (cursor) => api.members.list({ q, cursor, limit: adminPageMaxSize }),
  })
  const pending = useInvitationList('pending', q)
  const revokedList = useInvitationList('revoked', q, showRevoked)
  // A disabled query still holds its cached pages, so turning the option off has to hide them too.
  const revoked = showRevoked ? revokedList : null
  const linkReviews = useLinkReviewList('pending')
  const rejectedList = useLinkReviewList('rejected', showRejected)
  const rejectedReviews = showRejected ? rejectedList : null
  const breakGlass = useQuery({ queryKey: adminQueryKeys.breakGlass, queryFn: api.breakGlass.get })
  const noLocalAdmin = breakGlass.data?.allAdminsIdpManaged === true
  const listError =
    list.error ?? pending.error ?? revoked?.error ?? linkReviews.error ?? rejectedReviews?.error ?? breakGlass.error

  const selectedInvitationId = parseInvitationEditId(page.selectedId)
  const selectedInvitation =
    selectedInvitationId === null
      ? null
      : ([...pending.items, ...(revoked?.items ?? [])].find((item) => item.id === selectedInvitationId) ?? null)
  const selectedLinkReviewId = parseLinkReviewEditId(page.selectedId)
  // An `edit=link:` link opens the review even while its section is collapsed.
  const selectedLinkReview =
    [...linkReviews.items, ...(rejectedReviews?.items ?? [])].find((review) => review.id === selectedLinkReviewId) ??
    null
  const selectedMemberId =
    page.selectedId !== 'new' && selectedInvitationId === null && selectedLinkReviewId === null ? page.selectedId : null

  /** Turn a `?name=1` list option on or off. */
  const toggleParam = (name: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current)
      if (next.get(name) === '1') {
        next.delete(name)
      } else {
        next.set(name, '1')
      }
      return next
    })

  /** Delete a member for good; the confirm dialog closes the panel. Only the lists refetch: the detail would 404. */
  const purge = async (userId: string) => {
    await api.members.purge(userId)
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: adminQueryKeys.members.all,
        predicate: (query) => query.queryKey[2] === 'list',
      }),
      // Deleting an admin can leave none who signs in without the identity provider.
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.breakGlass }),
    ])
  }

  /** After an invite or a revoke: close the panel and say what happened, since the row moves or appears. */
  const invited = (invitation: Invitation) => {
    setNotice({ kind: 'invited', email: invitation.email })
    page.select(null)
  }
  const revokedInvitation = (invitation: Invitation) => {
    setNotice({ kind: 'revoked', email: invitation.email })
    page.select(null)
  }

  const hasInvitations = pending.items.length > 0 || (revoked?.items.length ?? 0) > 0

  return {
    page,
    list,
    pending,
    revoked,
    linkReviews,
    rejectedReviews,
    showRevoked,
    toggleRevoked: () => toggleParam('revoked'),
    showRejected,
    toggleRejected: () => toggleParam('rejected'),
    hasInvitations,
    isSearching: q !== undefined,
    listError,
    selectedMemberId,
    selectedInvitation,
    selectedLinkReview,
    notice,
    noLocalAdmin,
    setSearch,
    purge,
    invited,
    revokedInvitation,
  }
}
