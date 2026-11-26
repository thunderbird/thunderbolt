/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { AdminMember } from '@shared/admin-api'
import { InlineError } from '../../components/inline-error'
import type { useMembersPageState } from './use-members-page-state'

type BlockMemberDialogProps = {
  member: AdminMember
  block: ReturnType<typeof useMembersPageState>['block']
  onClose: () => void
}

/**
 * Confirm blocking a member, with an optional reason their panel and the audit log keep. Mounted
 * only while open, so each block starts with an empty reason.
 */
export const BlockMemberDialog = ({ member, block, onClose }: BlockMemberDialogProps) => {
  const { t } = useLingui()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const memberName = member.name || member.email

  return (
    <ConfirmActionDialog
      open
      title={t`Block ${memberName}?`}
      description={t`They're signed out everywhere and can't sign in until you unblock them.`}
      confirmLabel={t`Block member`}
      isPending={block.isPending}
      onCancel={onClose}
      onConfirm={() => block.mutate({ userId: member.userId, reason: reason.trim() }, { onSuccess: onClose })}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={reasonId}>
          <Trans>Reason (optional)</Trans>
        </Label>
        <Textarea id={reasonId} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        <InlineError error={block.error} />
      </div>
    </ConfirmActionDialog>
  )
}
