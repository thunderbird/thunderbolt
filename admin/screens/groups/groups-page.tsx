/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Boxes, Plus } from 'lucide-react'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { adminRole } from '@shared/admin-api'
import { AdminPage } from '../../components/admin-page'
import { BreakGlassBanner } from '../../components/break-glass-banner'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { ResourcePageDialogs } from '../../components/resource-page-dialogs'
import { StatusBadge } from '../../components/status-badge'
import { InlineError } from '../../components/inline-error'
import { itemContextMenuItems } from '../../components/item-actions'
import { groupActions } from './group-actions'
import { GroupPanel } from './group-panel'
import { useGroupsPageState } from './use-groups-page-state'

export const GroupsPage = () => {
  const { t } = useLingui()
  const { page, list, groups, setSearch, isSearching, breakGlassWarning, removingName, remove } = useGroupsPageState()
  const selectedId = page.selectedId

  return (
    <>
      <AdminPage
        title={t`Groups`}
        search={{ placeholder: t`Search groups`, onSearch: setSearch }}
        isEmpty={list.isEmpty}
        action={<PageCreateAction label={t`New Group`} onClick={() => page.requestSelect('new')} />}
        onClose={page.close}
        panel={
          selectedId && (
            // A fresh draft each time the form opens, and a fresh view after a save.
            <GroupPanel key={`${selectedId}:${page.isEditing}`} page={page} />
          )
        }
      >
        {breakGlassWarning && <BreakGlassBanner />}
        {list.isLoading && <ListSkeleton />}
        <InlineError error={list.error} />
        {groups.length > 0 && (
          <ul className="flex flex-col gap-4">
            {groups.map((group) => (
              <li key={group.id}>
                <SettingsSelectableRow
                  ariaLabel={t`Open ${group.name}`}
                  isSelected={selectedId === group.id && !page.isEditing}
                  onSelect={() => page.requestSelect(group.id)}
                  contextMenuItems={itemContextMenuItems(groupActions(page, group.id))}
                  title={group.name}
                  subtitle={<Plural value={group.memberCount} one="# member" other="# members" />}
                  trailingIcon={
                    group.roles.includes(adminRole) && (
                      <StatusBadge tone="info">
                        <Trans>Admin</Trans>
                      </StatusBadge>
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {isSearching && groups.length === 0 && list.items.length > 0 && (
          <SettingsNoResults>
            <Trans>No matching groups.</Trans>
          </SettingsNoResults>
        )}
        {list.isEmpty && (
          <EmptyState
            icon={Boxes}
            title={t`No groups yet`}
            action={
              <Button size="sm" variant="outline" onClick={() => page.requestSelect('new')}>
                <Plus />
                <Trans>Create your first group</Trans>
              </Button>
            }
          />
        )}
        <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
      </AdminPage>
      <ResourcePageDialogs
        page={page}
        remove={{
          title: removingName ? t`Delete ${removingName}?` : t`Delete this group?`,
          description: t`Its members lose any role this group gives them.`,
          confirmLabel: t`Delete group`,
          onConfirm: remove,
        }}
      />
    </>
  )
}
