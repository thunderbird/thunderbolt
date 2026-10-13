/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { DetailPanel, DetailDivider } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PreviewGroup } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'

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
  const [name, setName] = useState(group?.name ?? '')
  return (
    <DetailPanel title={group?.name ?? t`New group`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          preview.dispatch({
            type: 'save-group',
            group: { id: group?.id ?? crypto.randomUUID(), name: name.trim(), deletedAt: null },
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
          <Input id="admin-group-name" value={name} required onChange={(event) => setName(event.target.value)} />
        </DetailField>
        <Button type="submit" className="self-start" disabled={!name.trim()}>
          <Trans>Save changes</Trans>
        </Button>
      </form>
      {group && (
        <>
          <DetailDivider />
          <DetailField label={<Trans>Members</Trans>}>
            <p className="mb-3 text-sm text-muted-foreground">
              <Trans>Membership changes are saved automatically.</Trans>
            </p>
            {preview.members.map((member) => (
              <Label key={member.id} className="flex cursor-pointer items-center gap-3 py-2">
                <Checkbox
                  checked={member.groupIds.includes(group.id)}
                  onCheckedChange={(checked) =>
                    preview.dispatch({
                      type: 'membership',
                      memberId: member.id,
                      groupId: group.id,
                      enabled: checked === true,
                    })
                  }
                />
                <span>
                  <span className="block">{member.name}</span>
                  <span className="text-xs text-muted-foreground">{member.email}</span>
                </span>
              </Label>
            ))}
          </DetailField>
          <DetailDivider />
          <DetailField label={<Trans>Agents shared with this group</Trans>}>
            {preview.agents
              .filter(
                (agent) =>
                  agent.accessMode === 'everyone' ||
                  (agent.accessMode === 'restricted' && agent.groupIds.includes(group.id)),
              )
              .map((agent) => (
                <p key={agent.id} className="py-1 text-sm">
                  {agent.name}
                </p>
              ))}
          </DetailField>
          <Button
            type="button"
            variant="ghost"
            className="self-start text-destructive"
            onClick={() => {
              preview.dispatch({ type: 'remove', kind: 'groups', id: group.id, at: Date.now() })
              onClose()
            }}
          >
            <Trans>Remove group</Trans>
          </Button>
        </>
      )}
    </DetailPanel>
  )
}
