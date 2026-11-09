/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Trash2 } from 'lucide-react'
import { useReducer } from 'react'
import { DetailPanel, DetailDivider } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PreviewGroup, PreviewMember } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'
import { AgentAccessSummary } from './agent-access-summary'
import { MembershipMultiSelect } from './membership-multi-select'

type GroupEditorState = {
  draft: PreviewGroup
  memberIds: string[]
  removing: boolean
}

/** Hold both group details and membership selections until the form is saved. */
const useGroupEditorState = (group: PreviewGroup | undefined, members: PreviewMember[]) => {
  const [state, patch] = useReducer(
    (current: GroupEditorState, update: Partial<GroupEditorState>) => ({ ...current, ...update }),
    { group, members },
    ({ group: initialGroup, members: initialMembers }): GroupEditorState => ({
      draft: initialGroup ?? { id: crypto.randomUUID(), name: '', deletedAt: null },
      memberIds: initialGroup
        ? initialMembers.filter((member) => member.groupIds.includes(initialGroup.id)).map((member) => member.id)
        : [],
      removing: false,
    }),
  )
  return { ...state, patch }
}

export const GroupEditor = ({
  group,
  preview,
  onClose,
}: {
  group?: PreviewGroup
  preview: AdminPreview
  onClose: () => void
}) => {
  const { t } = useLingui()
  const { draft, memberIds, removing, patch } = useGroupEditorState(group, preview.members)
  return (
    <>
      <DetailPanel
        title={group?.name ?? t`New group`}
        onClose={onClose}
        actions={
          group && (
            <DetailActionsMenu>
              <DropdownMenuItem variant="destructive" onClick={() => patch({ removing: true })}>
                <Trash2 />
                <Trans>Remove group</Trans>
              </DropdownMenuItem>
            </DetailActionsMenu>
          )
        }
      >
        <form
          className="flex flex-1 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            preview.dispatch({
              type: 'save-group',
              group: { ...draft, name: draft.name.trim() },
              memberIds,
            })
            onClose()
          }}
        >
          <DetailField
            label={
              <Label htmlFor="admin-group-name">
                <Trans>Group name</Trans>
              </Label>
            }
          >
            <Input
              id="admin-group-name"
              value={draft.name}
              required
              onChange={(event) => patch({ draft: { ...draft, name: event.target.value } })}
            />
          </DetailField>
          <DetailField
            label={
              <Label htmlFor="admin-group-members">
                <Trans>Members</Trans>
              </Label>
            }
          >
            <MembershipMultiSelect
              id="admin-group-members"
              items={preview.members.map((member) => ({
                id: member.id,
                label: member.name,
                description: member.email,
              }))}
              selectedIds={memberIds}
              onChange={(ids) => patch({ memberIds: ids })}
              placeholder={t`Select members`}
              searchPlaceholder={t`Search members…`}
              emptyMessage={t`No members found`}
              removeLabel={(name) => t`Remove ${name}`}
            />
          </DetailField>
          <DetailDivider />
          <DetailField label={<Trans>Agents shared with this group</Trans>}>
            <AgentAccessSummary state={preview.state} group={draft} />
          </DetailField>
          <FormFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={!draft.name.trim()}>
              <Trans>Save changes</Trans>
            </Button>
          </FormFooter>
        </form>
      </DetailPanel>
      {group && (
        <ConfirmActionDialog
          open={removing}
          title={t`Remove group?`}
          description={t`Members will lose access granted through this group. Their other access will stay the same.`}
          confirmLabel={t`Remove group`}
          onCancel={() => patch({ removing: false })}
          onConfirm={() => {
            preview.dispatch({ type: 'remove', kind: 'groups', id: group.id, at: Date.now() })
            onClose()
          }}
        />
      )}
    </>
  )
}
