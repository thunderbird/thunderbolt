/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useReducer } from 'react'
import {
  adminPageMaxSize,
  type AdminMember,
  type AdminMemberWithWarning,
  type Invitation,
  type LinkReview,
  type ListInvitationsQuery,
} from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'
import { useConnections } from '../../api/use-connections'
import { hasBreakGlassWarning } from '../../components/break-glass-banner'
import { useAuth } from '@/contexts'
import { useResourcePageState } from '../../components/use-resource-page-state'
import { invitationEditId, parseInvitationEditId } from './invitation-rules'
import { linkReviewEditId, parseLinkReviewEditId } from './link-review-rules'
import { chainSegments, invitationRows, memberRows, reviewRows, withoutIds } from './member-list-rows'
import { useLinkReviewDecision, type LinkReviewDecision } from './use-link-review-decision'
import type { ConnectionStatusById } from './member-rules'
import { useDebounce } from '@/hooks/use-debounce'
import { searchDebounceMs } from '../../api/search-debounce'

/** One status of invitations, searched with the members. */
const useInvitationList = (query: Pick<ListInvitationsQuery, 'status' | 'expired' | 'q'>) => {
  const api = useAdminApi()
  return useCursorList<Invitation>({
    queryKey: adminQueryKeys.invitations.list(query),
    fetchPage: (cursor) => api.invitations.list({ ...query, cursor, limit: adminPageMaxSize }),
  })
}

/** One status of link reviews, searched with the members. */
const useLinkReviewList = (status: 'pending' | 'rejected', q: string | undefined) => {
  const api = useAdminApi()
  return useCursorList<LinkReview>({
    queryKey: adminQueryKeys.linkReviews.list({ status, q, limit: adminPageMaxSize }),
    fetchPage: (cursor) => api.linkReviews.list({ status, q, cursor, limit: adminPageMaxSize }),
  })
}

type PageUiState = {
  search: string
  /** The link review an approve or reject waits on a confirm for. */
  deciding: { review: LinkReview; decision: LinkReviewDecision } | null
  /** The member the block dialog is open for. */
  blocking: AdminMember | null
  /** Whether the last block or unblock left no admin who signs in without the identity provider. */
  blockWarning: boolean
}

type PageUiAction =
  | { type: 'search'; search: string }
  | { type: 'decide'; deciding: PageUiState['deciding'] }
  | { type: 'block'; blocking: AdminMember | null }
  | { type: 'blockApplied'; warning: boolean }

/** The Members page's UI state: the search, the review being decided and the member being blocked. */
const pageUiReducer = (state: PageUiState, action: PageUiAction): PageUiState => {
  switch (action.type) {
    case 'search':
      return { ...state, search: action.search }
    case 'decide':
      return { ...state, deciding: action.deciding }
    case 'block':
      return { ...state, blocking: action.blocking }
    case 'blockApplied':
      return { ...state, blockWarning: action.warning }
  }
}

const initialPageUi: PageUiState = { search: '', deciding: null, blocking: null, blockWarning: false }

/**
 * Members as one list, searched on the server: first what waits for an admin (pending link reviews,
 * then live invitations), then the members, then dimmed what's closed (rejected reviews, since
 * approving is how a rejection is undone, then expired and revoked invitations). Also the selected
 * member, invitation (`invite:<id>`), link review (`link:<id>`) or invite form (`new`); the decision
 * on a review; and whether any admin can sign in without the IdP.
 */
export const useMembersPageState = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const page = useResourcePageState()
  const [ui, dispatch] = useReducer(pageUiReducer, initialPageUi)
  const { deciding, blocking, blockWarning } = ui
  const q = useDebounce(ui.search.trim(), searchDebounceMs) || undefined

  const list = useCursorList<AdminMember>({
    queryKey: adminQueryKeys.members.list(q),
    fetchPage: (cursor) => api.members.list({ q, cursor, limit: adminPageMaxSize }),
  })
  const pendingReviews = useLinkReviewList('pending', q)
  const liveInvitations = useInvitationList({ status: 'pending', expired: false, q })
  const rejectedReviews = useLinkReviewList('rejected', q)
  const expiredInvitations = useInvitationList({ status: 'pending', expired: true, q })
  const revokedInvitations = useInvitationList({ status: 'revoked', q })
  const lists = [list, pendingReviews, liveInvitations, rejectedReviews, expiredInvitations, revokedInvitations]
  const breakGlass = useQuery({ queryKey: adminQueryKeys.breakGlass, queryFn: api.breakGlass.get })
  const noLocalAdmin = breakGlass.data?.allAdminsIdpManaged === true
  const listError = lists.find((each) => each.error)?.error ?? breakGlass.error

  const openReviews = withoutIds(pendingReviews.items, rejectedReviews.items)
  const live = withoutIds(liveInvitations.items, expiredInvitations.items, revokedInvitations.items)
  const expired = withoutIds(expiredInvitations.items, revokedInvitations.items)
  const reviews = [...openReviews, ...rejectedReviews.items]
  const invitations = [...live, ...expired, ...revokedInvitations.items]
  const rows = chainSegments([
    { list: pendingReviews, rows: reviewRows(openReviews) },
    { list: liveInvitations, rows: invitationRows(live) },
    { list, rows: memberRows(list.items) },
    { list: rejectedReviews, rows: reviewRows(rejectedReviews.items) },
    { list: expiredInvitations, rows: invitationRows(expired) },
    { list: revokedInvitations, rows: invitationRows(revokedInvitations.items) },
  ])

  const selectedInvitationId = parseInvitationEditId(page.selectedId)
  const selectedInvitation =
    selectedInvitationId === null ? null : (invitations.find((item) => item.id === selectedInvitationId) ?? null)
  const selectedLinkReviewId = parseLinkReviewEditId(page.selectedId)
  const selectedLinkReview = reviews.find((review) => review.id === selectedLinkReviewId) ?? null
  const selectedMemberId =
    page.selectedId !== 'new' && selectedInvitationId === null && selectedLinkReviewId === null ? page.selectedId : null

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

  /** After an invite, the new invitation opens, as a new skill does after Create. */
  const invited = (invitation: Invitation) => page.select(invitationEditId(invitation.id))
  /** Revoke the invitation a selection id names; it stays listed, dimmed, at the end. */
  const revokeInvitation = async (editId: string) => {
    await api.invitations.revoke(parseInvitationEditId(editId)!)
    await queryClient.invalidateQueries({ queryKey: adminQueryKeys.invitations.all })
  }

  // Approving or rejecting a review runs from its row and from its panel alike.
  const decision = useLinkReviewDecision({
    onDecided: () => {
      if (deciding && page.selectedId === linkReviewEditId(deciding.review.id)) {
        page.select(null)
      }
      dispatch({ type: 'decide', deciding: null })
    },
  })

  // Blocking and unblocking run from a member's row and from their panel alike.
  const selfId = useAuth().useSession().data?.user.id ?? null
  const connections = useConnections()
  const connectionStatusById: ConnectionStatusById = new Map(
    (connections.data ?? []).map((connection) => [connection.id, connection.status]),
  )
  const applied = async ({ warning, ...updated }: AdminMemberWithWarning) => {
    queryClient.setQueryData<AdminMember>(adminQueryKeys.members.detail(updated.userId), updated)
    dispatch({ type: 'blockApplied', warning: hasBreakGlassWarning({ warning }) })
    await Promise.all(
      [adminQueryKeys.members.all, adminQueryKeys.groups.all, adminQueryKeys.breakGlass].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
  }
  const block = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason: string }) =>
      api.members.block(userId, reason ? { reason } : {}),
    onSuccess: applied,
  })
  const unblock = useMutation({ mutationFn: (userId: string) => api.members.unblock(userId), onSuccess: applied })

  return {
    page,
    /** The members alone, as far as they've loaded. */
    list,
    rows,
    isLoading: lists.some((each) => each.isLoading),
    invitations,
    isSearching: q !== undefined,
    listError,
    selectedMemberId,
    selectedInvitation,
    selectedLinkReview,
    deciding,
    decide: (review: LinkReview, choice: LinkReviewDecision) => {
      decision.reset()
      dispatch({ type: 'decide', deciding: { review, decision: choice } })
    },
    cancelDecision: () => dispatch({ type: 'decide', deciding: null }),
    decision,
    noLocalAdmin: noLocalAdmin || blockWarning,
    selfId,
    connectionStatusById,
    blocking,
    startBlocking: (member: AdminMember) => dispatch({ type: 'block', blocking: member }),
    stopBlocking: () => dispatch({ type: 'block', blocking: null }),
    block,
    unblock,
    setSearch: (search: string) => dispatch({ type: 'search', search }),
    purge,
    /** A member as the list or their open panel last read them. */
    findMember: (userId: string) =>
      list.items.find((member) => member.userId === userId) ??
      queryClient.getQueryData<AdminMember>(adminQueryKeys.members.detail(userId)),
    invited,
    revokeInvitation,
  }
}
