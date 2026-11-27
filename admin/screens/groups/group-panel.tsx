/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { ResourcePageState } from '../../components/use-resource-page-state'
import { groupActions } from './group-actions'
import { GroupFormPanel } from './group-form-panel'
import { GroupViewPanel } from './group-view-panel'
import { useGroupPanelState } from './use-group-panel-state'

type GroupPanelProps = { page: ResourcePageState }

/** The open group's panel: its view, or the form that edits it (or creates one, for `new`). */
export const GroupPanel = ({ page }: GroupPanelProps) => {
  const groupId = page.selectedId === 'new' ? null : page.selectedId
  const panel = useGroupPanelState(groupId)

  if (page.isEditing) {
    return (
      <GroupFormPanel
        panel={panel}
        onCancel={page.cancelEdit}
        onDirtyChange={(dirty) => page.patch({ dirty })}
        // A save that left no local admin shows the page's banner once break-glass refetches.
        onSaved={({ groupId: savedId }) => page.select(savedId)}
      />
    )
  }
  return <GroupViewPanel panel={panel} actions={groupId ? groupActions(page, groupId) : []} onClose={page.close} />
}
