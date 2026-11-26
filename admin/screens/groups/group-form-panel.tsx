/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { InlineError } from '../../components/inline-error'
import { ListSkeleton } from '../../components/list-skeleton'
import { LoadMoreFooter } from '../../components/load-more-footer'
import { Combobox } from '@/components/ui/combobox'
import { GroupMemberList } from './group-member-list'
import { useGroupFormState, type DraftMember, type GroupFormState } from './use-group-form-state'
import type { GroupPanelState } from './use-group-panel-state'
import { FormField, FormGroup, FormLabel } from '../../components/form-field'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'

type GroupFormPanelProps = {
  panel: GroupPanelState
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
  /** After a save, with the group's id and whether it left no admin who can sign in without the IdP. */
  onSaved: (result: { groupId: string; warning: boolean }) => void
}

/** Edit a group, or create one: its name, description, admin role and members, saved together. */
export const GroupFormPanel = ({ panel, onCancel, onDirtyChange, onSaved }: GroupFormPanelProps) => {
  const { t } = useLingui()
  const group = panel.group.data
  const isNew = panel.group.fetchStatus === 'idle' && !group

  if (!isNew && (!group || panel.mappings.isPending)) {
    return (
      <DetailPanel title={t`Edit Group`} onClose={onCancel}>
        {panel.group.error ? <InlineError error={panel.group.error} /> : <ListSkeleton rows={3} variant="flat" />}
      </DetailPanel>
    )
  }

  return (
    <DetailPanel title={group ? t`Edit Group` : t`Create Group`} onClose={onCancel}>
      <GroupForm panel={panel} onCancel={onCancel} onDirtyChange={onDirtyChange} onSaved={onSaved} />
    </DetailPanel>
  )
}

const GroupForm = ({ panel, onCancel, onDirtyChange, onSaved }: GroupFormPanelProps) => {
  const { t } = useLingui()
  const nameId = useId()
  const descriptionId = useId()
  const adminId = useId()
  const form = useGroupFormState(panel, { onDirtyChange, onSaved })
  // A new group lands ready to type its name, as a new skill does.
  const nameRef = useAutofocusOnMount<HTMLInputElement>(form.isNew)
  const [confirmingSelfDemotion, setConfirmingSelfDemotion] = useState(false)
  const save = () => form.save.mutate(undefined, { onSettled: () => setConfirmingSelfDemotion(false) })

  return (
    <form
      className="flex flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!form.canSave) {
          return
        }
        if (form.isSelfDemoting) {
          setConfirmingSelfDemotion(true)
          return
        }
        save()
      }}
    >
      <FormField id={nameId} label={<Trans>Name</Trans>}>
        <Input
          id={nameId}
          ref={nameRef}
          value={form.draft.name}
          required
          maxLength={100}
          placeholder={t`Engineering`}
          disabled={form.save.isPending}
          onChange={(event) => form.setName(event.target.value)}
          className="md:h-9"
        />
      </FormField>
      <FormField id={descriptionId} label={<Trans>Description</Trans>}>
        <Textarea
          id={descriptionId}
          value={form.draft.description}
          maxLength={500}
          disabled={form.save.isPending}
          onChange={(event) => form.setDescription(event.target.value)}
        />
      </FormField>
      <div className="flex items-center justify-between gap-4">
        <FormLabel htmlFor={adminId} tooltip={<Trans>Everyone in this group is an admin.</Trans>}>
          <Trans>Admin group</Trans>
        </FormLabel>
        <Switch
          id={adminId}
          checked={form.draft.isAdmin}
          disabled={form.save.isPending}
          onCheckedChange={form.setIsAdmin}
        />
      </div>
      <InlineError error={panel.mappings.error} />
      <GroupMembersField panel={panel} form={form} />
      <FormFooter>
        <InlineError error={form.save.error} className="min-w-0 flex-1 truncate" />
        <ResponsiveModalCancel onClick={onCancel} className="dark:hover:bg-accent" />
        <Button
          type="submit"
          disabled={!form.canSave}
          isLoading={form.save.isPending}
          loadingLabel={form.isNew ? t`Creating…` : t`Saving…`}
        >
          {form.isNew ? <Trans>Create</Trans> : <Trans>Save</Trans>}
        </Button>
      </FormFooter>
      <ConfirmActionDialog
        open={confirmingSelfDemotion}
        title={t`Remove your own admin role?`}
        description={t`You'll lose access to the admin screens. Only another admin can give it back.`}
        confirmLabel={t`Save and lose admin`}
        isPending={form.save.isPending}
        onCancel={() => setConfirmingSelfDemotion(false)}
        onConfirm={save}
      />
    </form>
  )
}

/** The picker for adding people, then the members as they will be once the form is saved. */
const GroupMembersField = ({ panel, form }: { panel: GroupPanelState; form: GroupFormState }) => {
  const { t } = useLingui()
  const pickerId = useId()
  const { members } = panel
  const options: DraftMember[] = form.candidates.map((member) => ({
    userId: member.userId,
    label: member.name || member.email,
    detail: member.name ? member.email : undefined,
  }))
  const kept: DraftMember[] = members.items
    .filter((member) => !form.draft.removed.includes(member.userId))
    .map((member) => ({
      userId: member.userId,
      label: member.name || member.email,
      detail: member.name ? member.email : undefined,
    }))

  return (
    // No `<label htmlFor>`: it would rename the picker's trigger "Members" instead of "Add members".
    <FormGroup title={<Trans>Members</Trans>}>
      <div className="flex flex-col gap-3">
        {/* One pick adds one person to the list below; the picker itself stays empty. */}
        <Combobox
          id={pickerId}
          aria-label={t`Add member`}
          items={options.map((option) => ({ id: option.userId, label: option.label, description: option.detail }))}
          value={undefined}
          onValueChange={(userId) => form.addMembers(options.filter((option) => option.userId === userId))}
          searchValue={form.search}
          onSearchChange={form.setSearch}
          loading={form.isSearching}
          disabled={form.save.isPending}
          placeholder={t`Add member`}
          searchPlaceholder={t`Search by name or email`}
          emptyMessage={t`No matching members.`}
        />
        <InlineError error={members.error} />
        {members.isLoading && <ListSkeleton rows={2} variant="flat" />}
        <GroupMemberList
          members={[...form.draft.added, ...kept]}
          onRemove={form.removeMember}
          disabled={form.save.isPending}
        />
        <LoadMoreFooter hasMore={members.hasMore} isLoading={members.isLoadingMore} onLoadMore={members.loadMore} />
      </div>
    </FormGroup>
  )
}
