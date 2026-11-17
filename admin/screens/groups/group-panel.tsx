/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Trash2, X } from 'lucide-react'
import { useId, useState } from 'react'
import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { LocalGroup, UpdateGroupBody } from '@shared/admin-api'
import { BreakGlassBanner } from '../../components/break-glass-banner'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { MembershipMultiSelect } from '../../components/membership-multi-select'
import { RoleMappingControl } from '../../components/role-mapping-control'
import { InlineError } from '../members/inline-error'
import { useGroupPanelState, type GroupPanelState } from './use-group-panel-state'

type GroupDetailsFormProps = {
  group: LocalGroup | undefined
  save: GroupPanelState['save']
  onDirtyChange: (dirty: boolean) => void
  onCancel: () => void
}

type GroupDetails = { name: string; description: string }

/**
 * Name and description. The draft follows the saved values only while it has no unsaved edits,
 * so a refresh that brings in another admin's change never discards this admin's draft.
 */
const GroupDetailsForm = ({ group, save, onDirtyChange, onCancel }: GroupDetailsFormProps) => {
  const nameId = useId()
  const descriptionId = useId()
  const saved: GroupDetails = { name: group?.name ?? '', description: group?.description ?? '' }
  const [draft, setDraft] = useState(saved)
  // The saved values the draft started from: unsaved edits are whatever differs from these.
  const [base, setBase] = useState(saved)
  const differsFromBase = (next: GroupDetails) =>
    next.name.trim() !== base.name || next.description.trim() !== base.description
  const changed = differsFromBase(draft)
  if (!changed && (saved.name !== base.name || saved.description !== base.description)) {
    setBase(saved)
    setDraft(saved)
  }
  const update = (next: GroupDetails) => {
    setDraft(next)
    onDirtyChange(differsFromBase(next))
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        const submitted = { name: draft.name.trim(), description: draft.description.trim() }
        // For a group that exists, only what this admin changed: resending a field they left alone
        // would undo another admin's edit to it.
        const edited: UpdateGroupBody = {
          ...(submitted.name !== base.name && { name: submitted.name }),
          ...(submitted.description !== base.description && { description: submitted.description }),
        }
        save.mutate(group ? edited : submitted, {
          onSuccess: () => {
            setBase(submitted)
            onDirtyChange(false)
          },
        })
      }}
    >
      <DetailField
        label={
          <Label htmlFor={nameId}>
            <Trans>Group name</Trans>
          </Label>
        }
      >
        <Input
          id={nameId}
          value={draft.name}
          required
          maxLength={100}
          onChange={(event) => update({ ...draft, name: event.target.value })}
        />
      </DetailField>
      <DetailField
        label={
          <Label htmlFor={descriptionId}>
            <Trans>Description</Trans>
          </Label>
        }
      >
        <Textarea
          id={descriptionId}
          value={draft.description}
          maxLength={500}
          onChange={(event) => update({ ...draft, description: event.target.value })}
        />
      </DetailField>
      <InlineError error={save.error} />
      {(changed || !group) && (
        <div className="flex justify-end gap-2">
          {!group && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!draft.name.trim()} isLoading={save.isPending}>
            {group ? <Trans>Save changes</Trans> : <Trans>Create group</Trans>}
          </Button>
        </div>
      )}
    </form>
  )
}

type GroupMembersProps = { groupName: string; state: GroupPanelState }

/** The group's members, each removable, and a search to add more. */
const GroupMembers = ({ groupName, state }: GroupMembersProps) => {
  const { t } = useLingui()
  const pickerId = useId()
  const [confirmingSelfRemoval, setConfirmingSelfRemoval] = useState<string | null>(null)
  const { members, candidates, addMember, removeMember } = state
  const remove = (userId: string) => removeMember.mutate(userId, { onSettled: () => setConfirmingSelfRemoval(null) })

  return (
    // No `<Label htmlFor>`: it would rename the picker's trigger "Members" instead of "Add members".
    <DetailField label={<Trans>Members</Trans>}>
      <div className="flex flex-col gap-3">
        <MembershipMultiSelect
          id={pickerId}
          items={candidates.map((member) => ({
            id: member.userId,
            label: member.name || member.email,
            description: member.name ? member.email : undefined,
          }))}
          selectedIds={[]}
          onChange={(ids) => ids.forEach((userId) => addMember.mutate(userId))}
          onSearch={state.setSearch}
          placeholder={t`Add members`}
          searchPlaceholder={t`Search by name or email`}
          emptyMessage={t`No members to add.`}
          removeLabel={(name) => t`Remove ${name}`}
        />
        {state.breakGlassWarning && <BreakGlassBanner />}
        <InlineError error={members.error ?? addMember.error ?? removeMember.error} />
        {members.isLoading && <ListSkeleton rows={2} />}
        {members.isEmpty && (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>No one is in {groupName} yet.</Trans>
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {members.items.map((member) => {
            const memberName = member.name || member.email
            return (
              <li key={member.userId} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-[length:var(--font-size-body)]">{memberName}</span>
                  {member.name && (
                    <span className="block truncate text-[length:var(--font-size-xs)] text-muted-foreground">
                      {member.email}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t`Remove ${memberName} from the group`}
                  disabled={removeMember.isPending}
                  onClick={() =>
                    state.isSelfDemotingRemoval(member.userId)
                      ? setConfirmingSelfRemoval(member.userId)
                      : remove(member.userId)
                  }
                >
                  <X />
                </Button>
              </li>
            )
          })}
        </ul>
        <LoadMoreFooter hasMore={members.hasMore} isLoading={members.isLoadingMore} onLoadMore={members.loadMore} />
      </div>
      <ConfirmActionDialog
        open={confirmingSelfRemoval !== null}
        title={t`Remove your own admin role?`}
        description={t`You'll lose access to the admin screens. Only another admin can give it back.`}
        confirmLabel={t`Remove me from the group`}
        isPending={removeMember.isPending}
        onCancel={() => setConfirmingSelfRemoval(null)}
        onConfirm={() => confirmingSelfRemoval && remove(confirmingSelfRemoval)}
      />
    </DetailField>
  )
}

type GroupPanelProps = {
  /** Null for a new group. */
  groupId: string | null
  onClose: () => void
  onCreated: (groupId: string) => void
  onDirtyChange: (dirty: boolean) => void
  onRequestDelete: () => void
}

/** A local group: its name, whether its members are admins, and who is in it. */
export const GroupPanel = ({ groupId, onClose, onCreated, onDirtyChange, onRequestDelete }: GroupPanelProps) => {
  const { t } = useLingui()
  const state = useGroupPanelState(groupId, onCreated)
  const group = state.group.data

  if (groupId && !group) {
    return (
      <DetailPanel title={t`Group`} onClose={onClose}>
        {state.group.error ? <InlineError error={state.group.error} /> : <ListSkeleton rows={3} />}
      </DetailPanel>
    )
  }

  return (
    <DetailPanel
      title={group?.name ?? t`New group`}
      onClose={onClose}
      actions={
        group && (
          <DetailActionsMenu>
            <DropdownMenuItem variant="destructive" onClick={onRequestDelete}>
              <Trash2 />
              <Trans>Delete group</Trans>
            </DropdownMenuItem>
          </DetailActionsMenu>
        )
      }
    >
      <GroupDetailsForm group={group} save={state.save} onDirtyChange={onDirtyChange} onCancel={onClose} />
      {group && (
        <>
          <DetailDivider />
          <RoleMappingControl target={{ localGroupId: group.id }} groupName={group.name} />
          <DetailDivider />
          <GroupMembers groupName={group.name} state={state} />
        </>
      )}
    </DetailPanel>
  )
}
