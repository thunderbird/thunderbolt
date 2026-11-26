/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { InlineError } from '../../components/inline-error'
import { ItemActionsMenu, type ItemAction } from '../../components/item-actions'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { GroupMemberList } from './group-member-list'
import type { GroupPanelState } from './use-group-panel-state'

type GroupViewPanelProps = {
  panel: GroupPanelState
  actions: ItemAction[]
  onClose: () => void
}

/** A local group, read-only: its description, whether its members are admins, and who is in it. */
export const GroupViewPanel = ({ panel, actions, onClose }: GroupViewPanelProps) => {
  const { t } = useLingui()
  const group = panel.group.data

  if (!group) {
    return (
      <DetailPanel title={t`Group`} onClose={onClose}>
        {panel.group.error ? <InlineError error={panel.group.error} /> : <ListSkeleton rows={3} variant="flat" />}
      </DetailPanel>
    )
  }

  const { members } = panel
  return (
    <DetailPanel
      title={group.name}
      // Status sits in the subtitle, as a built-in skill's "Read-only" does.
      subtitle={panel.adminMapping ? t`Admin group` : undefined}
      onClose={onClose}
      actions={<ItemActionsMenu actions={actions} />}
    >
      <InlineError error={panel.mappings.error} />
      {group.description && (
        <>
          <DetailField label={<Trans>Description</Trans>}>
            <p className="whitespace-pre-wrap break-words text-base leading-snug text-foreground">
              {group.description}
            </p>
          </DetailField>
          <DetailDivider />
        </>
      )}
      <DetailField label={<Trans>Members</Trans>}>
        <InlineError error={members.error} />
        {members.isLoading && <ListSkeleton rows={2} variant="flat" />}
        {members.isEmpty && (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>No members yet</Trans>
          </p>
        )}
        <GroupMemberList
          members={members.items.map((member) => ({
            userId: member.userId,
            label: member.name || member.email,
            detail: member.name ? member.email : undefined,
          }))}
        />
        <LoadMoreFooter hasMore={members.hasMore} isLoading={members.isLoadingMore} onLoadMore={members.loadMore} />
      </DetailField>
    </DetailPanel>
  )
}
