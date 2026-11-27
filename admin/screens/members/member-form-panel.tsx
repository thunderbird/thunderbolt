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
import type { AdminMember } from '@shared/admin-api'
import { InlineError } from '../../components/inline-error'
import { MembershipMultiSelect } from '../../components/membership-multi-select'
import { useMemberFormState } from './use-member-form-state'
import { FormField, FormGroup, FormLabel } from '../../components/form-field'

type MemberFormPanelProps = {
  member: AdminMember
  selfId: string | null
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
  onSaved: () => void
}

/** Edit a member: their name, their own admin grant and their local groups, saved together. */
export const MemberFormPanel = ({ member, selfId, onCancel, onDirtyChange, onSaved }: MemberFormPanelProps) => {
  const { t } = useLingui()
  const nameId = useId()
  const adminId = useId()
  const groupsId = useId()
  const form = useMemberFormState(member, selfId, { onDirtyChange, onSaved })
  const [confirmingSelfDemotion, setConfirmingSelfDemotion] = useState(false)
  const save = () => form.save.mutate(undefined, { onSettled: () => setConfirmingSelfDemotion(false) })

  return (
    <DetailPanel title={t`Edit Member`} onClose={onCancel}>
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
        {/* Locked while saving, so an edit made mid-save isn't marked saved without being sent. */}
        <fieldset disabled={form.save.isPending} className="contents">
          <FormField id={nameId} label={<Trans>Name</Trans>}>
            <Input
              id={nameId}
              value={form.draft.name}
              required={member.name !== ''}
              maxLength={200}
              disabled={form.isNameIdpManaged}
              onChange={(event) => form.setName(event.target.value)}
              className="md:h-9"
            />
          </FormField>
          <div className="flex items-center justify-between gap-4">
            <FormLabel htmlFor={adminId}>
              <Trans>Admin</Trans>
            </FormLabel>
            <Switch id={adminId} checked={form.draft.isAdmin} onCheckedChange={form.setIsAdmin} />
          </div>
          {/* No `<label htmlFor>`: it would rename the picker's trigger "Groups" instead of "Choose groups". */}
          <FormGroup title={<Trans>Groups</Trans>}>
            <MembershipMultiSelect
              id={groupsId}
              items={form.groupOptions}
              selectedIds={form.draft.groupIds}
              onChange={form.setGroupIds}
              placeholder={t`Choose groups`}
              searchPlaceholder={t`Search groups`}
              emptyMessage={t`No groups.`}
              removeLabel={(name) => t`Remove from ${name}`}
            />
            <InlineError error={form.groupsError} />
          </FormGroup>
        </fieldset>
        <FormFooter>
          <InlineError error={form.save.error} className="min-w-0 flex-1 truncate" />
          <ResponsiveModalCancel onClick={onCancel} className="dark:hover:bg-accent" />
          <Button type="submit" disabled={!form.canSave} isLoading={form.save.isPending} loadingLabel={t`Saving…`}>
            <Trans>Save</Trans>
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
    </DetailPanel>
  )
}
