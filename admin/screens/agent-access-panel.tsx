/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { DetailField } from '@/components/settings/detail-field'
import { Button, buttonVariants } from '@/components/ui/button'
import { SearchableMenu, type SearchableMenuGroup } from '@/components/ui/searchable-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AccessMode, PreviewAgent } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'

type AccessTarget = { kind: 'group' | 'member'; id: string }

/** Pending mode changes are explicit; restricted grants save immediately, matching the source design. */
const useAgentAccess = (agent: PreviewAgent, preview: AdminPreview) => {
  const [pending, setPending] = useState<AccessMode | null>(null)
  const save = (accessMode: AccessMode, groupIds = agent.groupIds, memberIds = agent.memberIds) =>
    preview.dispatch({ type: 'agent-access', id: agent.id, accessMode, groupIds, memberIds })
  const updateTarget = (target: AccessTarget, add: boolean) => {
    const ids = target.kind === 'group' ? agent.groupIds : agent.memberIds
    const next = add ? [...new Set([...ids, target.id])] : ids.filter((id) => id !== target.id)
    save(
      'restricted',
      target.kind === 'group' ? next : agent.groupIds,
      target.kind === 'member' ? next : agent.memberIds,
    )
  }
  return {
    mode: pending ?? agent.accessMode,
    dirty: pending !== null && pending !== agent.accessMode,
    setPending,
    updateTarget,
    saveMode: () => {
      if (pending) {
        save(pending)
      }
      setPending(null)
    },
    discard: () => setPending(null),
  }
}

export const AgentAccessPanel = ({ agent, preview }: { agent: PreviewAgent; preview: AdminPreview }) => {
  const { t } = useLingui()
  const access = useAgentAccess(agent, preview)
  const groups = preview.groups.filter((group) => agent.groupIds.includes(group.id))
  const members = preview.members.filter((member) => agent.memberIds.includes(member.id))
  const targets = [
    ...groups.map((group) => ({ kind: 'group' as const, id: group.id, label: t`Group · ${group.name}` })),
    ...members.map((member) => ({
      kind: 'member' as const,
      id: member.id,
      label: t`Member · ${member.name || member.email}`,
    })),
  ]
  const options: SearchableMenuGroup<AccessTarget>[] = [
    {
      id: 'groups',
      label: t`Groups`,
      items: preview.groups
        .filter((group) => !agent.groupIds.includes(group.id))
        .map((group) => ({ id: `group:${group.id}`, label: group.name, data: { kind: 'group', id: group.id } })),
    },
    {
      id: 'members',
      label: t`Individuals`,
      items: preview.members
        .filter((member) => !agent.memberIds.includes(member.id))
        .map((member) => ({
          id: `member:${member.id}`,
          label: member.name || member.email,
          data: { kind: 'member', id: member.id },
        })),
    },
  ]
  return (
    <>
      <DetailField label={<Trans>Access</Trans>}>
        <Select
          value={access.mode}
          onValueChange={(value) => {
            if (value === 'everyone' || value === 'admins' || value === 'restricted') {
              access.setPending(value)
            }
          }}
        >
          <SelectTrigger aria-label={t`Access level`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="everyone">
              <Trans>Everyone</Trans>
            </SelectItem>
            <SelectItem value="admins">
              <Trans>Admin only</Trans>
            </SelectItem>
            <SelectItem value="restricted">
              <Trans>Restricted</Trans>
            </SelectItem>
          </SelectContent>
        </Select>
      </DetailField>
      {access.dirty && (
        <div className="flex gap-2">
          <Button onClick={access.saveMode}>
            <Trans>Save access</Trans>
          </Button>
          <Button variant="ghost" onClick={access.discard}>
            <Trans>Discard</Trans>
          </Button>
        </div>
      )}
      {agent.accessMode === 'everyone' && (
        <p className="text-sm text-muted-foreground">
          <Trans>Everyone in your organization can use this agent.</Trans>
        </p>
      )}
      {agent.accessMode === 'admins' && (
        <DetailField label={<Trans>Admins with access</Trans>}>
          {preview.members
            .filter((member) => member.role === 'admin')
            .map((member) => (
              <p key={member.id} className="py-1">
                {member.name || member.email}
              </p>
            ))}
        </DetailField>
      )}
      {agent.accessMode === 'restricted' && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">
              <Trans>Who can access</Trans>
            </h3>
            <SearchableMenu
              items={options}
              searchable
              searchPlaceholder={t`Search groups or people…`}
              emptyMessage={t`No groups or people found`}
              mobileTitle={t`Add access`}
              align="end"
              onValueChange={(_id, item) => {
                if (item.data) {
                  access.updateTarget(item.data, true)
                }
              }}
              trigger={
                <span className={buttonVariants({ variant: 'ghost', size: 'icon' })}>
                  <Plus />
                  <span className="sr-only">
                    <Trans>Add access</Trans>
                  </span>
                </span>
              }
            />
          </div>
          {targets.map((target) => (
            <div
              key={`${target.kind}:${target.id}`}
              className="flex items-center justify-between gap-3 border-b border-border/60 pb-2"
            >
              <span>{target.label}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t`Revoke access for ${target.label}`}
                onClick={() => access.updateTarget(target, false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
          {!targets.length && (
            <p className="text-sm text-muted-foreground">
              <Trans>No one yet. Add a group or individual.</Trans>
            </p>
          )}
        </>
      )}
    </>
  )
}
