/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Users } from 'lucide-react'
import { IconTile } from '@/components/settings/icon-tile'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { adminRole } from '@shared/admin-api'
import { AdminPage } from '../../components/admin-page'
import { BreakGlassBanner } from '../../components/break-glass-banner'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { InlineError } from '../members/inline-error'
import { GroupPanel } from './group-panel'
import { useGroupsPageState } from './use-groups-page-state'

export const GroupsPage = () => {
  const { t } = useLingui()
  const { page, list, breakGlassWarning, remove } = useGroupsPageState()
  const selectedId = page.selectedId

  return (
    <>
      <AdminPage
        title={t`Groups`}
        action={<PageCreateAction label={t`New group`} onClick={() => page.requestSelect('new')} />}
        onClose={page.close}
        panel={
          selectedId && (
            <GroupPanel
              key={selectedId}
              groupId={selectedId === 'new' ? null : selectedId}
              onClose={page.close}
              onCreated={page.select}
              onDirtyChange={(dirty) => page.patch({ dirty })}
              onRequestDelete={() => page.patch({ removeId: selectedId })}
            />
          )
        }
      >
        <p className="text-sm text-muted-foreground">
          <Trans>
            Group members to manage them together. A group mapped to the admin role makes its members admins.
          </Trans>
        </p>
        {breakGlassWarning && <BreakGlassBanner />}
        {list.isLoading && <ListSkeleton />}
        <InlineError error={list.error} />
        {list.items.map((group) => (
          <SettingsSelectableRow
            key={group.id}
            ariaLabel={group.name}
            isSelected={selectedId === group.id}
            onSelect={() => page.requestSelect(selectedId === group.id ? null : group.id)}
            leading={
              <IconTile>
                <Users className="size-5 text-muted-foreground" />
              </IconTile>
            }
            title={group.name}
            subtitle={<Plural value={group.memberCount} one="# member" other="# members" />}
            trailing={
              group.roles.includes(adminRole) && (
                <StatusBadge tone="info">
                  <Trans>Admin</Trans>
                </StatusBadge>
              )
            }
          />
        ))}
        {list.isEmpty && (
          <SettingsNoResults>
            <Trans>No groups yet.</Trans>
          </SettingsNoResults>
        )}
        <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
      </AdminPage>
      <ResourcePageDialogs
        page={page}
        remove={{
          title: t`Delete this group?`,
          description: t`Its members lose any role the group gives them. Their other access stays the same.`,
          confirmLabel: t`Delete group`,
          onConfirm: remove,
        }}
      />
    </>
  )
}
