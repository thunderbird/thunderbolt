/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Check, Mail, Plus, UserRound } from 'lucide-react'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { useFormatters } from '@/i18n/use-formatters'
import type { AdminMember, Invitation } from '@shared/admin-api'
import { AdminPage } from '../../components/admin-page'
import { AdminSection } from '../../components/admin-section'
import { BreakGlassBanner } from '../../components/break-glass-banner'
import { InlineError } from '../../components/inline-error'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { InvitationPanel } from './invitation-panel'
import { invitationEditId, isExpiredInvitation } from './invitation-rules'
import { InvitePanel } from './invite-panel'
import { LinkReviewPanel } from './link-review-panel'
import { MemberPanel } from './member-panel'
import { isAdmin } from './member-rules'
import { PendingLinkReviews } from './pending-link-reviews'
import { useMembersPageState } from './use-members-page-state'

const MemberBadges = ({ member }: { member: AdminMember }) => (
  <span className="flex flex-wrap items-center gap-1.5">
    {isAdmin(member) && (
      <StatusBadge tone="info">
        <Trans>Admin</Trans>
      </StatusBadge>
    )}
    {member.blocked ? (
      <StatusBadge tone="danger">
        <Trans>Blocked</Trans>
      </StatusBadge>
    ) : (
      !member.access.allowed && (
        <StatusBadge tone="warning">
          <Trans>No access</Trans>
        </StatusBadge>
      )
    )}
  </span>
)

/** An invited address, in the members list until they sign in. */
const InvitationRow = ({
  invitation,
  isSelected,
  onSelect,
}: {
  invitation: Invitation
  isSelected: boolean
  onSelect: () => void
}) => {
  const formatters = useFormatters()
  const expiresOn = formatters.date(invitation.expiresAt)
  const expired = isExpiredInvitation(invitation)

  const subtitle = () => {
    if (invitation.status === 'revoked') {
      return <Trans>Invitation revoked</Trans>
    }
    return expired ? <Trans>Invitation expired {expiresOn}</Trans> : <Trans>Invitation expires {expiresOn}</Trans>
  }

  return (
    <SettingsSelectableRow
      ariaLabel={invitation.email}
      isSelected={isSelected}
      onSelect={onSelect}
      leading={
        <IconTile>
          <Mail className="size-5 text-muted-foreground" />
        </IconTile>
      }
      title={invitation.email}
      subtitle={subtitle()}
      trailing={
        <span className="flex flex-wrap items-center gap-1.5">
          {invitation.idpOverride && (
            <StatusBadge tone="neutral">
              <Trans>IdP override</Trans>
            </StatusBadge>
          )}
          {/* Only an exception gets a status badge: the section already says the rest are pending. */}
          {invitation.status === 'revoked' && (
            <StatusBadge tone="danger">
              <Trans>Revoked</Trans>
            </StatusBadge>
          )}
          {expired && (
            <StatusBadge tone="danger">
              <Trans>Expired</Trans>
            </StatusBadge>
          )}
        </span>
      }
    />
  )
}

/** Members in three collapsible sections: identities waiting to be linked, invitations, and the members themselves. */
export const MembersPage = () => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const state = useMembersPageState()
  const { page, list, pending, revoked, notice } = state
  const revokedCount = revoked?.items.length ?? 0
  const pendingCount = pending.hasMore
    ? `${formatters.number(pending.items.length)}+`
    : formatters.number(pending.items.length)

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
          onRevoked={state.revokedInvitation}
        />
      )
    }
    if (state.selectedLinkReview) {
      return (
        <LinkReviewPanel
          key={state.selectedLinkReview.id}
          review={state.selectedLinkReview}
          onClose={page.close}
          onDecided={() => page.select(null)}
        />
      )
    }
    if (state.selectedMemberId) {
      return (
        <MemberPanel
          key={state.selectedMemberId}
          userId={state.selectedMemberId}
          onClose={page.close}
          onDirtyChange={(dirty) => page.patch({ dirty })}
          onRequestPurge={() => page.patch({ removeId: state.selectedMemberId })}
        />
      )
    }
    return null
  }

  const invitationRow = (invitation: Invitation) => {
    const editId = invitationEditId(invitation.id)
    return (
      <InvitationRow
        key={invitation.id}
        invitation={invitation}
        isSelected={page.selectedId === editId}
        onSelect={() => page.requestSelect(page.selectedId === editId ? null : editId)}
      />
    )
  }

  return (
    <>
      <AdminPage
        title={t`Members`}
        search={{ label: t`Search members`, placeholder: t`Search by name or email`, onSearch: state.setSearch }}
        action={
          <>
            <DetailActionsMenu>
              <DropdownMenuItem className="cursor-pointer" onClick={state.toggleRevoked}>
                <Check className={state.showRevoked ? undefined : 'invisible'} />
                <Trans>Show revoked invitations</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onClick={state.toggleRejected}>
                <Check className={state.showRejected ? undefined : 'invisible'} />
                <Trans>Show rejected links</Trans>
              </DropdownMenuItem>
            </DetailActionsMenu>
            <PageCreateAction label={t`Invite member`} onClick={() => page.requestSelect('new')} />
          </>
        }
        onClose={page.close}
        panel={panel()}
      >
        {state.noLocalAdmin && <BreakGlassBanner />}
        {notice && (
          <p role="status" className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {notice.kind === 'invited' ? (
              <Trans>Invitation sent to {notice.email}.</Trans>
            ) : (
              <Trans>Invitation to {notice.email} revoked.</Trans>
            )}
          </p>
        )}
        <PendingLinkReviews
          reviews={state.linkReviews}
          rejected={state.rejectedReviews}
          selectedId={page.selectedId}
          onSelect={page.requestSelect}
        />
        <InlineError error={state.listError} />
        <AdminSection
          title={<Trans>Invitations</Trans>}
          description={<Trans>Sent by email, and shown here until the person signs in.</Trans>}
          summary={
            <>
              {pending.items.length > 0 && <StatusBadge tone="neutral">{pendingCount}</StatusBadge>}
              {revokedCount > 0 && (
                <StatusBadge tone="danger">
                  <Plural value={revokedCount} one="# revoked" other="# revoked" />
                </StatusBadge>
              )}
            </>
          }
        >
          {pending.isLoading && <ListSkeleton />}
          {!state.hasInvitations && pending.isEmpty && (
            <SettingsEmptyState
              icon={<Mail className="size-10 text-muted-foreground" />}
              title={state.isSearching ? t`No matching invitations` : t`No pending invitations`}
              description={
                state.isSearching
                  ? t`No invitation was sent to an address like that.`
                  : t`Invite people by email. They show here until they sign in.`
              }
              action={
                !state.isSearching && (
                  <Button variant="outline" onClick={() => page.requestSelect('new')}>
                    <Plus className="mr-2 size-4" />
                    <Trans>Invite member</Trans>
                  </Button>
                )
              }
            />
          )}
          {pending.items.map(invitationRow)}
          <LoadMoreFooter hasMore={pending.hasMore} isLoading={pending.isLoadingMore} onLoadMore={pending.loadMore} />
          {revoked?.items.map(invitationRow)}
          {revoked && (
            <LoadMoreFooter hasMore={revoked.hasMore} isLoading={revoked.isLoadingMore} onLoadMore={revoked.loadMore} />
          )}
        </AdminSection>
        <AdminSection title={<Trans>Members</Trans>}>
          {list.isLoading && <ListSkeleton />}
          {list.isEmpty && (
            <SettingsEmptyState
              icon={<UserRound className="size-10 text-muted-foreground" />}
              title={state.isSearching ? t`No matching members` : t`No members yet`}
              description={
                state.isSearching
                  ? t`Nobody's name or email matches that search.`
                  : t`People show here once they sign in or an identity provider adds them.`
              }
            />
          )}
          {list.items.map((member) => (
            <SettingsSelectableRow
              key={member.userId}
              ariaLabel={member.name || member.email}
              isSelected={page.selectedId === member.userId}
              onSelect={() => page.requestSelect(page.selectedId === member.userId ? null : member.userId)}
              leading={
                <IconTile>
                  <UserRound className="size-5 text-muted-foreground" />
                </IconTile>
              }
              title={member.name || member.email}
              subtitle={member.name ? member.email : undefined}
              trailing={<MemberBadges member={member} />}
            />
          ))}
          <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
        </AdminSection>
      </AdminPage>
      <ResourcePageDialogs
        page={page}
        remove={{
          title: t`Delete this member permanently?`,
          description: t`Their account and all their data are deleted. This can't be undone.`,
          confirmLabel: t`Delete member`,
          onConfirm: state.purge,
        }}
      />
    </>
  )
}
