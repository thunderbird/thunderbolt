/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useFormatters } from '@/i18n/use-formatters'
import type { AdminMember } from '@shared/admin-api'
import { StatusBadge } from '../../components/status-badge'
import { InlineError } from '../../components/inline-error'
import { getRenameState } from './member-rules'
import type { MemberPanelState } from './use-member-panel-state'

type MemberProfileSectionProps = {
  member: AdminMember
  rename: MemberPanelState['rename']
  onDirtyChange: (dirty: boolean) => void
}

/** Name, email and join date, with what the identity provider manages labelled. Key it on the name to reset the draft. */
export const MemberProfileSection = ({ member, rename, onDirtyChange }: MemberProfileSectionProps) => {
  const { i18n } = useLingui()
  const formatters = useFormatters()
  const nameId = useId()
  const reasonId = useId()
  const [name, setName] = useState(member.name)
  const renameState = getRenameState(member)
  const changed = name.trim() !== member.name && name.trim() !== ''
  const managedBy = member.idpManaged?.connections.map((connection) => connection.name).join(', ')

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        rename.mutate(name.trim(), { onSuccess: () => onDirtyChange(false) })
      }}
    >
      {(managedBy || member.requiresSso) && (
        <div className="flex flex-wrap gap-1.5">
          {managedBy && (
            <StatusBadge tone="info">
              <Trans>Managed by {managedBy}</Trans>
            </StatusBadge>
          )}
          {member.requiresSso && (
            <StatusBadge tone="neutral">
              <Trans>Signs in with SSO only</Trans>
            </StatusBadge>
          )}
        </div>
      )}
      <DetailField
        label={
          <Label htmlFor={nameId}>
            <Trans>Name</Trans>
          </Label>
        }
      >
        <Input
          id={nameId}
          value={name}
          required
          maxLength={200}
          readOnly={!renameState.available}
          aria-describedby={renameState.available ? undefined : reasonId}
          onChange={(event) => {
            setName(event.target.value)
            onDirtyChange(event.target.value.trim() !== member.name)
          }}
        />
        {!renameState.available && (
          <p id={reasonId} className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {i18n._(renameState.reason)}
          </p>
        )}
      </DetailField>
      {changed && (
        <div className="flex justify-end">
          <Button type="submit" size="sm" isLoading={rename.isPending}>
            <Trans>Save name</Trans>
          </Button>
        </div>
      )}
      <InlineError error={rename.error} />
      <DetailField label={<Trans>Email</Trans>}>
        <p className="text-[length:var(--font-size-body)] break-all">{member.email}</p>
      </DetailField>
      <DetailField label={<Trans>Joined</Trans>}>
        <p className="text-[length:var(--font-size-body)]">{formatters.date(member.joinedAt)}</p>
      </DetailField>
    </form>
  )
}
