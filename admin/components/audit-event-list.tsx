/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { useFormatters } from '@/i18n/use-formatters'
import type { AuditActorType, AuditEvent, AuditEventQuery, AuditOutcome } from '@shared/admin-api'
import { getAuditActionLabel, getAuditTargetLabel } from '../api/audit-action-labels'
import { adminQueryKeys } from '../api/query-keys'
import { useAdminApi } from '../api/use-admin-api'
import { useCursorList } from '../api/use-cursor-list'
import { ListSkeleton } from './list-skeleton'
import { LoadMoreFooter } from './load-more-footer'
import { StatusBadge, type StatusTone } from './status-badge'
import { InlineError } from './inline-error'

const actorLabels: Record<AuditActorType, MessageDescriptor> = {
  user: msg`Person`,
  api_key: msg`API key`,
  scim_connection: msg`SCIM connection`,
  system: msg`System`,
}

const outcomeLabels: Record<AuditOutcome, MessageDescriptor> = {
  success: msg`Success`,
  failure: msg`Failure`,
  denied: msg`Denied`,
}

const outcomeTones: Record<AuditOutcome, StatusTone> = { success: 'success', failure: 'danger', denied: 'warning' }

/** A target type by its label, or as code when this build doesn't know it. */
const TargetType = ({ type }: { type: string }) => {
  const { i18n } = useLingui()
  const label = getAuditTargetLabel(type)
  return label ? <>{i18n._(label)}</> : <code>{type}</code>
}

type AuditEventListProps = {
  filters: AuditEventQuery
  /** Extra detail under an event, e.g. a SCIM request's failure. */
  renderDetails?: (event: AuditEvent) => ReactNode
  emptyMessage?: ReactNode
}

/** Audit events matching `filters`, newest first, with "Load more". */
export const AuditEventList = ({ filters, renderDetails, emptyMessage }: AuditEventListProps) => {
  const { i18n } = useLingui()
  const formatters = useFormatters()
  const api = useAdminApi()
  const list = useCursorList({
    queryKey: adminQueryKeys.auditEvents.list(filters),
    fetchPage: (cursor) => api.auditEvents.list({ ...filters, cursor }),
  })

  if (list.isLoading) {
    return <ListSkeleton />
  }
  if (list.error && list.items.length === 0) {
    return <InlineError error={list.error} />
  }
  if (list.isEmpty) {
    return <SettingsNoResults>{emptyMessage ?? <Trans>No events.</Trans>}</SettingsNoResults>
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y">
        {list.items.map((event) => {
          const label = getAuditActionLabel(event.action)
          return (
            <li key={event.id} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{label ? i18n._(label) : <code>{event.action}</code>}</span>
                <StatusBadge tone={outcomeTones[event.outcome]}>{i18n._(outcomeLabels[event.outcome])}</StatusBadge>
                {event.reason && <code className="text-[length:var(--font-size-xs)]">{event.reason}</code>}
                <time
                  dateTime={event.occurredAt}
                  title={formatters.date(event.occurredAt)}
                  className="ml-auto text-[length:var(--font-size-xs)] text-muted-foreground"
                >
                  {formatters.relativeTime(event.occurredAt)}
                </time>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--font-size-sm)] text-muted-foreground">
                <span>
                  {i18n._(actorLabels[event.actorType])}
                  {event.actorId && <code className="ml-1 break-all">{event.actorId}</code>}
                </span>
                {event.targetType && (
                  <span>
                    <TargetType type={event.targetType} />
                    {event.targetId && <code className="ml-1 break-all">{event.targetId}</code>}
                  </span>
                )}
                {event.ipAddress && <span>{event.ipAddress}</span>}
                {event.userAgent && <span className="max-w-full truncate">{event.userAgent}</span>}
              </div>
              {renderDetails?.(event)}
            </li>
          )
        })}
      </ul>
      <InlineError error={list.error} />
      <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
    </div>
  )
}
