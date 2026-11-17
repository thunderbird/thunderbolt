/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId, useState } from 'react'
import { DetailField } from '@/components/settings/detail-field'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useFormatters } from '@/i18n/use-formatters'
import type { AdminMember } from '@shared/admin-api'
import { StatusBadge } from '../../components/status-badge'
import { GuardedAction } from './guarded-action'
import { InlineError } from './inline-error'
import { accessRefusalLabels } from './member-labels'
import { getBlockState } from './member-rules'
import type { MemberPanelState } from './use-member-panel-state'

type MemberAccessSectionProps = {
  member: AdminMember
  selfId: string | null
  block: MemberPanelState['block']
  unblock: MemberPanelState['unblock']
}

/** Whether the member can sign in, and blocking or unblocking them. A block takes an optional reason. */
export const MemberAccessSection = ({ member, selfId, block, unblock }: MemberAccessSectionProps) => {
  const { i18n } = useLingui()
  const formatters = useFormatters()
  const reasonId = useId()
  const [blocking, setBlocking] = useState(false)
  const [reason, setReason] = useState('')
  const blockedOn = member.blocked ? formatters.date(member.blocked.at) : ''
  const blockReason = member.blocked?.reason

  return (
    <DetailField label={<Trans>Access</Trans>}>
      <div className="flex flex-col gap-3">
        <div>
          {member.access.allowed ? (
            <StatusBadge tone="success">
              <Trans>Can sign in</Trans>
            </StatusBadge>
          ) : (
            <StatusBadge tone="danger">{i18n._(accessRefusalLabels[member.access.reason])}</StatusBadge>
          )}
        </div>
        {member.blocked && (
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            {blockReason ? (
              <Trans>
                Blocked on {blockedOn}: {blockReason}
              </Trans>
            ) : (
              <Trans>Blocked on {blockedOn}</Trans>
            )}
          </p>
        )}
        {member.blocked ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              isLoading={unblock.isPending}
              onClick={() => unblock.mutate()}
            >
              <Trans>Unblock</Trans>
            </Button>
          </div>
        ) : blocking ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              block.mutate(reason.trim(), { onSuccess: () => setBlocking(false) })
            }}
          >
            <Label htmlFor={reasonId}>
              <Trans>Reason (optional)</Trans>
            </Label>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              <Trans>
                They're signed out everywhere and can't sign in, even through your identity provider, until you unblock
                them.
              </Trans>
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setBlocking(false)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" variant="destructive" size="sm" isLoading={block.isPending}>
                <Trans>Block member</Trans>
              </Button>
            </div>
          </form>
        ) : (
          <GuardedAction availability={getBlockState(member, selfId)} onClick={() => setBlocking(true)}>
            <Trans>Block</Trans>
          </GuardedAction>
        )}
        <InlineError error={block.error ?? unblock.error} />
      </div>
    </DetailField>
  )
}
