/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { DetailField } from '@/components/settings/detail-field'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import type { AdminMember } from '@shared/admin-api'
import { StatusBadge, type StatusTone } from '../../components/status-badge'
import { GuardedAction } from './guarded-action'
import { InlineError } from './inline-error'
import { sourceKindLabels, sourceStatusLabels } from './member-labels'
import { getDetachState, type ConnectionStatusById } from './member-rules'
import type { MemberPanelState } from './use-member-panel-state'

const statusTones: Record<AdminMember['sources'][number]['status'], StatusTone> = {
  active: 'success',
  suspended: 'warning',
  removed: 'danger',
}

type MemberSourcesSectionProps = {
  member: AdminMember
  selfId: string | null
  connectionStatusById: ConnectionStatusById
  detach: MemberPanelState['detach']
}

/** What admits the member, each with its status and connection, and detaching a SCIM link. */
export const MemberSourcesSection = ({ member, selfId, connectionStatusById, detach }: MemberSourcesSectionProps) => {
  const { t, i18n } = useLingui()
  const [detaching, setDetaching] = useState<{ id: string; name: string } | null>(null)
  const connectionName = detaching?.name ?? ''

  return (
    <DetailField label={<Trans>How they sign in</Trans>}>
      <ul className="flex flex-col gap-3">
        {member.sources.map((source, index) => {
          const detachState = getDetachState(source, member, selfId, connectionStatusById)
          const connection = source.connection
          const sourceConnectionName = connection?.name ?? ''
          return (
            <li key={`${source.kind}-${connection?.id ?? index}`} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[length:var(--font-size-body)] font-medium">
                  {i18n._(sourceKindLabels[source.kind])}
                </span>
                <StatusBadge tone={statusTones[source.status]}>{i18n._(sourceStatusLabels[source.status])}</StatusBadge>
              </div>
              {connection && (
                <span className="text-[length:var(--font-size-sm)] text-muted-foreground">{connection.name}</span>
              )}
              {detachState && connection && (
                <GuardedAction
                  availability={detachState}
                  aria-label={t`Detach from ${sourceConnectionName}`}
                  onClick={() => setDetaching(connection)}
                >
                  <Trans>Detach</Trans>
                </GuardedAction>
              )}
            </li>
          )
        })}
      </ul>
      <InlineError error={detach.error} />
      <ConfirmActionDialog
        open={detaching !== null}
        title={t`Detach from ${connectionName}?`}
        description={t`This removes their link to this identity provider. Their other sign-in sources then decide their access.`}
        confirmLabel={t`Detach`}
        isPending={detach.isPending}
        onCancel={() => setDetaching(null)}
        onConfirm={() => detaching && detach.mutate(detaching.id, { onSettled: () => setDetaching(null) })}
      />
    </DetailField>
  )
}
