/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Mail, UserRound } from 'lucide-react'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { useFormatters } from '@/i18n/use-formatters'
import type { AdminMember, Invitation } from '@shared/admin-api'
import { AdminPage } from '../../components/admin-page'
import { BreakGlassBanner } from '../../components/break-glass-banner'
import { InlineError } from '../../components/inline-error'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { InvitationPanel } from './invitation-panel'
import { invitationEditId, isExpiredInvitation } from './invitation-rules'
import { InvitePanel } from './invite-panel'
import { MemberPanel } from './member-panel'
import { isAdmin } from './member-rules'
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

/** Members, with invited addresses among them until they sign in. */
export const MembersPage = () => {
  const { t } = useLingui()
  const state = useMembersPageState()
  const { page, list, pending, revoked, notice } = state

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
            </DetailActionsMenu>
            <PageCreateAction label={t`Invite member`} onClick={() => page.requestSelect('new')} />
          </>
        }
        onClose={page.close}
        panel={panel()}
      >
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>
            Manage who can sign in, their admin role, and the identity providers they come from. Invited people show
            here until they sign in.
          </Trans>
        </p>
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
        {(list.isLoading || pending.isLoading) && <ListSkeleton />}
        <InlineError error={state.listError} />
        {pending.items.map(invitationRow)}
        <LoadMoreFooter hasMore={pending.hasMore} isLoading={pending.isLoadingMore} onLoadMore={pending.loadMore} />
        {revoked?.items.map(invitationRow)}
        {revoked && (
          <LoadMoreFooter hasMore={revoked.hasMore} isLoading={revoked.isLoadingMore} onLoadMore={revoked.loadMore} />
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
        {state.isEmpty && (
          <SettingsNoResults>
            <Trans>No matching members.</Trans>
          </SettingsNoResults>
        )}
        <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
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
