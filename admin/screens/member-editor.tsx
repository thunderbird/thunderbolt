/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useReducer, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { DetailPanel, DetailDivider } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { PreviewMember } from '../data'
import { AgentAccessSummary } from './agent-access-summary'
import { MembershipMultiSelect } from './membership-multi-select'
import type { AdminPreview } from '../use-admin-preview-state'

/** A member draft never changes the sample model before confirmation. */
const useMemberEditorState = (member?: PreviewMember) => {
  const [draft, patch] = useReducer(
    (state: PreviewMember, update: Partial<PreviewMember>) => ({ ...state, ...update }),
    member ?? {
      id: crypto.randomUUID(),
      name: '',
      email: '',
      role: 'member',
      status: 'invited',
      groupIds: [],
      deletedAt: null,
    },
  )
  const [removeOpen, setRemoveOpen] = useState(false)
  return { draft, patch, removeOpen, setRemoveOpen }
}

export const MemberEditor = ({
  member,
  preview,
  onClose,
}: {
  member?: PreviewMember
  preview: AdminPreview
  onClose: () => void
}) => {
  const { t } = useLingui()
  const { draft, patch, removeOpen, setRemoveOpen } = useMemberEditorState(member)
  const duplicateEmail = preview.members.some(
    (item) => item.id !== draft.id && item.email.toLowerCase() === draft.email.trim().toLowerCase(),
  )
  return (
    <DetailPanel
      title={member?.name ?? t`Invite member`}
      subtitle={t`Organization membership`}
      onClose={onClose}
      actions={
        member && (
          <DetailActionsMenu>
            <DropdownMenuItem variant="destructive" onClick={() => setRemoveOpen(true)}>
              <Trash2 />
              <Trans>Remove member</Trans>
            </DropdownMenuItem>
          </DetailActionsMenu>
        )
      }
    >
      <form
        className="flex flex-1 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (duplicateEmail) {
            return
          }
          preview.dispatch({
            type: 'save-member',
            member: { ...draft, name: draft.name.trim(), email: draft.email.trim() },
          })
          onClose()
        }}
      >
        <DetailField
          label={
            <Label htmlFor="admin-member-name">
              <Trans>Name</Trans>
            </Label>
          }
        >
          <Input id="admin-member-name" value={draft.name} required onChange={(e) => patch({ name: e.target.value })} />
        </DetailField>
        <DetailField
          label={
            <Label htmlFor="admin-member-email">
              <Trans>Email</Trans>
            </Label>
          }
        >
          <Input
            id="admin-member-email"
            type="email"
            value={draft.email}
            required
            onChange={(e) => patch({ email: e.target.value })}
            aria-invalid={duplicateEmail}
          />
          {duplicateEmail && (
            <p role="alert" className="text-sm text-destructive">
              <Trans>This email is already in the preview.</Trans>
            </p>
          )}
        </DetailField>
        <DetailField
          label={
            <Label htmlFor="admin-member-role">
              <Trans>Role</Trans>
            </Label>
          }
        >
          <Select value={draft.role} onValueChange={(value) => patch({ role: value === 'admin' ? 'admin' : 'member' })}>
            <SelectTrigger id="admin-member-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">
                <Trans>Member</Trans>
              </SelectItem>
              <SelectItem value="admin">
                <Trans>Administrator</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
        </DetailField>
        <DetailField
          label={
            <Label htmlFor="admin-member-groups">
              <Trans>Groups</Trans>
            </Label>
          }
        >
          <MembershipMultiSelect
            id="admin-member-groups"
            items={preview.groups.map((group) => ({ id: group.id, label: group.name }))}
            selectedIds={draft.groupIds}
            onChange={(groupIds) => patch({ groupIds })}
            placeholder={t`Select groups`}
            searchPlaceholder={t`Search groups`}
            emptyMessage={t`No matching groups.`}
            removeLabel={(name) => t`Remove from ${name}`}
          />
        </DetailField>
        <DetailDivider />
        <DetailField label={<Trans>Agents with access</Trans>}>
          <AgentAccessSummary member={draft} state={preview.state} />
        </DetailField>
        <FormFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!draft.name.trim() || !draft.email.trim() || duplicateEmail}>
            <Trans>Save changes</Trans>
          </Button>
        </FormFooter>
      </form>
      {member && (
        <ConfirmActionDialog
          open={removeOpen}
          title={t`Remove ${member.name}?`}
          description={t`This member will lose their organization membership and agent access.`}
          confirmLabel={t`Remove member`}
          onCancel={() => setRemoveOpen(false)}
          onConfirm={() => {
            preview.dispatch({ type: 'remove', kind: 'members', id: member.id, at: Date.now() })
            onClose()
          }}
        />
      )}
    </DetailPanel>
  )
}
