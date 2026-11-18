/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { UserRound } from 'lucide-react'
import { useNavigate } from 'react-router'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import type { AdminMember } from '@shared/admin-api'
import { AdminPage } from '../../components/admin-page'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { InlineError } from '../../components/inline-error'
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

export const MembersPage = () => {
  const { t } = useLingui()
  const navigate = useNavigate()
  const { page, list, setSearch, purge } = useMembersPageState()

  return (
    <>
      <AdminPage
        title={t`Members`}
        search={{ label: t`Search members`, placeholder: t`Search by name or email`, onSearch: setSearch }}
        action={<PageCreateAction label={t`Invite member`} onClick={() => navigate('/admin/invitations?edit=new')} />}
        onClose={page.close}
        panel={
          page.selectedId && (
            <MemberPanel
              key={page.selectedId}
              userId={page.selectedId}
              onClose={page.close}
              onDirtyChange={(dirty) => page.patch({ dirty })}
              onRequestPurge={() => page.patch({ removeId: page.selectedId })}
            />
          )
        }
      >
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>Manage who can sign in, their admin role, and the identity providers they come from.</Trans>
        </p>
        {list.isLoading && <ListSkeleton />}
        <InlineError error={list.error} />
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
        {list.isEmpty && (
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
          onConfirm: purge,
        }}
      />
    </>
  )
}
