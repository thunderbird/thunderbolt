/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Plus, UserRound } from 'lucide-react'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { useFormatters } from '@/i18n/use-formatters'
import type { AdminMember, Invitation, LinkReview } from '@shared/admin-api'
import { AdminPage } from '../../components/admin-page'
import { BreakGlassBanner } from '../../components/break-glass-banner'
import { InlineError } from '../../components/inline-error'
import { itemContextMenuItems } from '../../components/item-actions'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { BlockMemberDialog } from './block-member-dialog'
import { InvitationPanel } from './invitation-panel'
import { invitationEditId, isExpiredInvitation, parseInvitationEditId } from './invitation-rules'
import { InvitePanel } from './invite-panel'
import { LinkReviewConfirmDialog } from './link-review-confirm-dialog'
import { LinkReviewPanel } from './link-review-panel'
import { linkReviewEditId } from './link-review-rules'
import { invitationActions, linkReviewActions, memberActions } from './member-actions'
import { InvitationBadge, LinkReviewBadge, MemberBadges } from './member-badges'
import type { MemberListRow } from './member-list-rows'
import { MemberPanel } from './member-panel'
import { useMembersPageState } from './use-members-page-state'

/** What an invitation's row says under the address: when it expires, or when it was sent once revoked. */
const InvitationSubtitle = ({ invitation }: { invitation: Invitation }) => {
  const formatters = useFormatters()
  if (invitation.status === 'revoked') {
    const invitedOn = formatters.date(invitation.createdAt)
    return <Trans>Invited {invitedOn}</Trans>
  }
  const expiresOn = formatters.date(invitation.expiresAt)
  return isExpiredInvitation(invitation) ? <Trans>Expired {expiresOn}</Trans> : <Trans>Expires {expiresOn}</Trans>
}

/**
 * Members as one list: the link reviews and invitations waiting for an admin first, then the members,
 * then the rejected reviews and the expired and revoked invitations, dimmed. A badge says what each is.
 */
export const MembersPage = () => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const state = useMembersPageState()
  const { page, rows, invitations } = state
  /** A row is highlighted while its view is open, not its edit form, as in Skills. */
  const isOpen = (id: string) => page.selectedId === id && !page.isEditing

  // The confirm names what it removes: an invitation's address, or the member.
  const removingInvitationId = parseInvitationEditId(page.removeId)
  const removingMember = page.removeId ? state.findMember(page.removeId) : undefined
  const removingName =
    removingInvitationId !== null
      ? (invitations.find((item) => item.id === removingInvitationId)?.email ?? '')
      : removingMember
        ? removingMember.name || removingMember.email
        : ''

  /** A member's actions, the same in their row's right-click menu and their panel's ⋯ menu. */
  const actionsOf = (member: AdminMember) =>
    memberActions(member, {
      page,
      selfId: state.selfId,
      connectionStatusById: state.connectionStatusById,
      onBlock: state.startBlocking,
      onUnblock: (unblocked) => state.unblock.mutate(unblocked.userId),
    })
  const reviewActionsOf = (review: LinkReview) =>
    linkReviewActions(review, { selfId: state.selfId, onDecide: (choice) => state.decide(review, choice) })

  const panel = () => {
    if (page.selectedId === 'new') {
      return (
        <InvitePanel onClose={page.close} onInvited={state.invited} onDirtyChange={(dirty) => page.patch({ dirty })} />
      )
    }
    if (state.selectedInvitation) {
      return (
        <InvitationPanel
          key={state.selectedInvitation.id}
          invitation={state.selectedInvitation}
          onClose={page.close}
          actions={invitationActions(state.selectedInvitation, page)}
        />
      )
    }
    if (state.selectedLinkReview) {
      return (
        <LinkReviewPanel
          key={state.selectedLinkReview.id}
          review={state.selectedLinkReview}
          isOwnAccount={state.selectedLinkReview.candidateUserId === state.selfId}
          actions={reviewActionsOf(state.selectedLinkReview)}
          onClose={page.close}
        />
      )
    }
    if (state.selectedMemberId) {
      return (
        // A fresh draft each time the form opens.
        <MemberPanel
          key={`${state.selectedMemberId}:${page.isEditing}`}
          userId={state.selectedMemberId}
          isEditing={page.isEditing}
          actions={actionsOf}
          onCancelEdit={page.cancelEdit}
          onSaved={() => page.select(state.selectedMemberId)}
          onClose={page.close}
          onDirtyChange={(dirty) => page.patch({ dirty })}
        />
      )
    }
    return null
  }

  const memberRow = (member: AdminMember) => (
    <SettingsSelectableRow
      ariaLabel={t`Open ${member.name || member.email}`}
      isSelected={isOpen(member.userId)}
      isDimmed={member.blocked !== null}
      onSelect={() => page.requestSelect(member.userId)}
      contextMenuItems={itemContextMenuItems(actionsOf(member))}
      title={member.name || member.email}
      subtitle={member.name ? member.email : undefined}
      trailingIcon={<MemberBadges member={member} />}
    />
  )

  const reviewRow = (review: LinkReview) => {
    const editId = linkReviewEditId(review.id)
    const connection = review.connection.name
    const lastSeen = formatters.relativeTime(review.lastSeenAt)
    return (
      <SettingsSelectableRow
        // Not "Open {email}": the account it would link to is usually a member with the same email.
        ariaLabel={t`Open link review for ${review.incomingEmail}`}
        isSelected={isOpen(editId)}
        isDimmed={review.status === 'rejected'}
        onSelect={() => page.requestSelect(editId)}
        contextMenuItems={itemContextMenuItems(reviewActionsOf(review))}
        title={review.incomingEmail}
        subtitle={t`${connection} · ${lastSeen}`}
        trailingIcon={<LinkReviewBadge review={review} />}
      />
    )
  }

  const invitationRow = (invitation: Invitation) => {
    const editId = invitationEditId(invitation.id)
    return (
      <SettingsSelectableRow
        ariaLabel={t`Open ${invitation.email}`}
        isSelected={isOpen(editId)}
        isDimmed={invitation.status === 'revoked' || isExpiredInvitation(invitation)}
        onSelect={() => page.requestSelect(editId)}
        contextMenuItems={itemContextMenuItems(invitationActions(invitation, page))}
        title={invitation.email}
        subtitle={<InvitationSubtitle invitation={invitation} />}
        trailingIcon={<InvitationBadge invitation={invitation} />}
      />
    )
  }

  const listRow = (row: MemberListRow) => {
    switch (row.kind) {
      case 'review':
        return reviewRow(row.review)
      case 'invitation':
        return invitationRow(row.invitation)
      case 'member':
        return memberRow(row.member)
    }
  }

  const body = () => {
    if (state.isLoading) {
      return <ListSkeleton />
    }
    if (rows.rows.length === 0) {
      return state.isSearching ? (
        <SettingsNoResults>
          <Trans>No matching members.</Trans>
        </SettingsNoResults>
      ) : (
        <EmptyState
          icon={UserRound}
          title={t`No members yet`}
          action={
            <Button size="sm" variant="outline" onClick={() => page.requestSelect('new')}>
              <Plus />
              <Trans>Invite your first member</Trans>
            </Button>
          }
        />
      )
    }
    return (
      <>
        <ul className="flex flex-col gap-4">
          {rows.rows.map((row) => (
            <li key={row.key}>{listRow(row)}</li>
          ))}
        </ul>
        <LoadMoreFooter hasMore={rows.hasMore} isLoading={rows.isLoadingMore} onLoadMore={rows.loadMore} />
      </>
    )
  }

  return (
    <>
      <AdminPage
        title={t`Members`}
        search={{ placeholder: t`Search members`, onSearch: state.setSearch }}
        isEmpty={!state.isLoading && !state.isSearching && rows.rows.length === 0}
        action={<PageCreateAction label={t`Invite Member`} onClick={() => page.requestSelect('new')} />}
        onClose={page.close}
        panel={panel()}
      >
        {state.noLocalAdmin && <BreakGlassBanner />}
        <InlineError error={state.listError ?? state.unblock.error} />
        {body()}
      </AdminPage>
      {state.blocking && <BlockMemberDialog member={state.blocking} block={state.block} onClose={state.stopBlocking} />}
      {state.deciding && (
        <LinkReviewConfirmDialog
          review={state.deciding.review}
          decision={state.deciding.decision}
          isPending={state.decision.isPending}
          error={state.decision.error}
          onConfirm={(choice) => state.decision.mutate({ reviewId: state.deciding!.review.id, decision: choice })}
          onCancel={state.cancelDecision}
        />
      )}
      <ResourcePageDialogs
        page={page}
        // The one confirm serves both kinds of removal: revoking an invitation, or deleting a member.
        remove={
          removingInvitationId !== null
            ? {
                title: t`Revoke the invitation to ${removingName}?`,
                description: t`Its link stops working.`,
                confirmLabel: t`Revoke invitation`,
                // A revoked invitation stays listed, dimmed, at the end.
                closesPanel: false,
                onConfirm: state.revokeInvitation,
              }
            : {
                title: t`Delete ${removingName} permanently?`,
                description: t`Their account and all their data are deleted. This can't be undone.`,
                confirmLabel: t`Delete member`,
                onConfirm: state.purge,
              }
        }
      />
    </>
  )
}
