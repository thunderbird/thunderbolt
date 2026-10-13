/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useReducer } from 'react'
import { DetailPanel, DetailDivider } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { PreviewMember } from '../data'
import { canMemberUseAgent } from '../agent-access'
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
  return { draft, patch }
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
  const { draft, patch } = useMemberEditorState(member)
  const duplicateEmail = preview.members.some(
    (item) => item.id !== draft.id && item.email.toLowerCase() === draft.email.trim().toLowerCase(),
  )
  return (
    <DetailPanel title={member?.name ?? t`Invite member`} subtitle={t`Organization membership`} onClose={onClose}>
      {member && (
        <DetailField label={<Trans>Agents with access</Trans>}>
          {preview.state.policy.thunderboltAllowed && <p className="text-sm">Thunderbolt</p>}
          {preview.agents
            .filter((agent) => canMemberUseAgent(agent, member, preview.state))
            .map((agent) => (
              <p key={agent.id} className="text-sm">
                {agent.name}
              </p>
            ))}
        </DetailField>
      )}
      <form
        className="flex flex-col gap-5"
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
        <DetailDivider />
        <DetailField label={<Trans>Groups</Trans>}>
          {preview.groups.map((group) => (
            <Label key={group.id} className="flex cursor-pointer items-center gap-3 py-2">
              <Checkbox
                checked={draft.groupIds.includes(group.id)}
                onCheckedChange={(checked) =>
                  patch({
                    groupIds:
                      checked === true ? [...draft.groupIds, group.id] : draft.groupIds.filter((id) => id !== group.id),
                  })
                }
              />
              {group.name}
            </Label>
          ))}
        </DetailField>
        <div className="flex gap-2">
          <Button type="submit" disabled={!draft.name.trim() || !draft.email.trim() || duplicateEmail}>
            <Trans>Save changes</Trans>
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
        {member && (
          <Button
            type="button"
            variant="ghost"
            className="self-start text-destructive"
            onClick={() => {
              preview.dispatch({ type: 'remove', kind: 'members', id: member.id, at: Date.now() })
              onClose()
            }}
          >
            <Trans>Remove member</Trans>
          </Button>
        )}
      </form>
    </DetailPanel>
  )
}
