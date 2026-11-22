/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { useFormatters } from '@/i18n/use-formatters'
import { parseUserAgent, type WebBrowser, type WebOsPlatform } from '@/lib/platform'
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

const osLabels: Record<Exclude<WebOsPlatform, 'unknown'>, MessageDescriptor> = {
  macos: msg`macOS`,
  windows: msg`Windows`,
  linux: msg`Linux`,
  ios: msg`iOS`,
  android: msg`Android`,
}

const browserLabels: Record<Exclude<WebBrowser, 'unknown'>, MessageDescriptor> = {
  chrome: msg`Chrome`,
  edge: msg`Edge`,
  firefox: msg`Firefox`,
  safari: msg`Safari`,
}

/**
 * "Firefox on macOS", or whichever half the user agent names, with the raw string in the tooltip. A client
 * neither half recognises (curl, the CLI, an SDK) shows its raw string, truncated.
 */
const ClientLabel = ({ userAgent }: { userAgent: string }) => {
  const { t, i18n } = useLingui()
  const { os, browser } = parseUserAgent(userAgent)
  const osName = os === 'unknown' ? null : i18n._(osLabels[os])
  const browserName = browser === 'unknown' ? null : i18n._(browserLabels[browser])
  if (!osName && !browserName) {
    return (
      <span title={userAgent} className="max-w-60 truncate font-mono">
        {userAgent}
      </span>
    )
  }
  return (
    <span title={userAgent}>{osName && browserName ? t`${browserName} on ${osName}` : (browserName ?? osName)}</span>
  )
}

/** Who did it: their name when the server knows one, else what kind of actor they are. Ids are in the tooltip. */
const ActorLabel = ({ event }: { event: AuditEvent }) => {
  const { i18n } = useLingui()
  return <span title={event.actorId ?? undefined}>{event.actorLabel ?? i18n._(actorLabels[event.actorType])}</span>
}

/** What it was done to: its name, else its type (as code when this build doesn't know it). */
const TargetLabel = ({ event }: { event: AuditEvent }) => {
  const { i18n } = useLingui()
  const type = event.targetType ?? ''
  const typeLabel = getAuditTargetLabel(type)
  const title = [type, event.targetId].filter(Boolean).join(' ')
  if (event.targetLabel) {
    return <span title={title}>{event.targetLabel}</span>
  }
  return <span title={title}>{typeLabel ? i18n._(typeLabel) : <code>{type}</code>}</span>
}

/** A sign-in's target is its own actor; naming the person twice says nothing. */
const targetIsActor = (event: AuditEvent) => event.targetType === event.actorType && event.targetId === event.actorId

/** What happened, to what and by whom, as one message so a translation can put the three in its own order. */
const EventSummary = ({ event }: { event: AuditEvent }) => {
  const { i18n } = useLingui()
  const actionLabel = getAuditActionLabel(event.action)
  const action = (
    <span className="text-[length:var(--font-size-body)] font-medium text-foreground">
      {actionLabel ? i18n._(actionLabel) : <code>{event.action}</code>}
    </span>
  )
  const actor = <ActorLabel event={event} />
  if (event.targetType && !targetIsActor(event)) {
    const target = <TargetLabel event={event} />
    return (
      <span>
        <Trans>
          {action} {target} by {actor}
        </Trans>
      </span>
    )
  }
  return (
    <span>
      <Trans>
        {action} by {actor}
      </Trans>
    </span>
  )
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
        {list.items.map((event) => (
          <li key={event.id} className="flex flex-col gap-1 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--font-size-sm)] text-muted-foreground">
                <EventSummary event={event} />
                {event.outcome !== 'success' && (
                  <StatusBadge tone={outcomeTones[event.outcome]}>{i18n._(outcomeLabels[event.outcome])}</StatusBadge>
                )}
                {event.reason && <code className="text-[length:var(--font-size-xs)]">{event.reason}</code>}
                {event.userAgent && <ClientLabel userAgent={event.userAgent} />}
                {event.ipAddress && <span className="font-mono">{event.ipAddress}</span>}
              </p>
              <time
                dateTime={event.occurredAt}
                title={formatters.date(event.occurredAt)}
                className="shrink-0 text-[length:var(--font-size-xs)] text-muted-foreground"
              >
                {formatters.relativeTime(event.occurredAt)}
              </time>
            </div>
            {renderDetails?.(event)}
          </li>
        ))}
      </ul>
      <InlineError error={list.error} />
      <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
    </div>
  )
}
