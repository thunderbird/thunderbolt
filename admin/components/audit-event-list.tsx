/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { useFormatters } from '@/i18n/use-formatters'
import type { AuditEvent, AuditEventQuery } from '@shared/admin-api'
import { getAuditActionLabel, getAuditTargetLabel } from '../api/audit-action-labels'
import { adminQueryKeys } from '../api/query-keys'
import { useAdminApi } from '../api/use-admin-api'
import { useCursorList } from '../api/use-cursor-list'
import {
  auditActionName,
  auditActorName,
  auditTargetTypeName,
  outcomeLabels,
  outcomeTones,
  readableClient,
  targetIsActor,
} from './audit-event-labels'
import { ListSkeleton } from './list-skeleton'
import { LoadMoreFooter } from './load-more-footer'
import { StatusBadge } from './status-badge'
import { InlineError } from './inline-error'
import { useHour12 } from './use-hour12'

/** The client the user agent names, with the raw string in the tooltip; an unnamed one shows it raw, truncated. */
const ClientLabel = ({ userAgent }: { userAgent: string }) => {
  const { i18n } = useLingui()
  const name = readableClient(i18n, userAgent)
  if (!name) {
    return (
      <span title={userAgent} className="max-w-60 truncate font-mono">
        {userAgent}
      </span>
    )
  }
  return <span title={userAgent}>{name}</span>
}

/** Who did it: their name when the server knows one, else what kind of actor they are. Ids are in the tooltip. */
const ActorLabel = ({ event }: { event: AuditEvent }) => {
  const { i18n } = useLingui()
  return <span title={event.actorId ?? undefined}>{auditActorName(i18n, event)}</span>
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

/** The event's summary as one plain string, for a row's accessible name. */
const useEventSummaryText = () => {
  const { t, i18n } = useLingui()
  return (event: AuditEvent) => {
    const action = auditActionName(i18n, event.action)
    const actor = auditActorName(i18n, event)
    if (event.targetType && !targetIsActor(event)) {
      const target = event.targetLabel ?? auditTargetTypeName(i18n, event.targetType)
      return t`${action} ${target} by ${actor}`
    }
    return t`${action} by ${actor}`
  }
}

/** Whether the event has anything for the muted second line. */
const hasDetails = (event: AuditEvent) => Boolean(event.reason || event.userAgent || event.ipAddress)

/** Why it failed, the client and the IP: the muted second line under an event. */
const EventDetails = ({ event }: { event: AuditEvent }) => (
  <>
    {event.reason && <code>{event.reason}</code>}
    {event.userAgent && <ClientLabel userAgent={event.userAgent} />}
    {event.ipAddress && <span className="font-mono">{event.ipAddress}</span>}
  </>
)

const OutcomeBadge = ({ event }: { event: AuditEvent }) => {
  const { i18n } = useLingui()
  return event.outcome === 'success' ? null : (
    <StatusBadge tone={outcomeTones[event.outcome]}>{i18n._(outcomeLabels[event.outcome])}</StatusBadge>
  )
}

/** When it happened: relative, with the full date and time in the tooltip. */
const EventTime = ({ event, className }: { event: AuditEvent; className?: string }) => {
  const formatters = useFormatters()
  const hour12 = useHour12()
  return (
    <time
      dateTime={event.occurredAt}
      title={`${formatters.date(event.occurredAt)} ${formatters.time(event.occurredAt, { hour12 })}`}
      className={className}
    >
      {formatters.relativeTime(event.occurredAt)}
    </time>
  )
}

/** A page of audit events at a time, for one set of filters. Callers with the same filters share the query. */
export const useAuditEventList = (filters: AuditEventQuery) => {
  const api = useAdminApi()
  return useCursorList({
    queryKey: adminQueryKeys.auditEvents.list(filters),
    fetchPage: (cursor) => api.auditEvents.list({ ...filters, cursor }),
  })
}

type AuditEventListProps = {
  filters: AuditEventQuery
  /** Extra detail under an event, e.g. a SCIM request's failure. Only for a list whose rows don't open. */
  renderDetails?: (event: AuditEvent) => ReactNode
  /** Shown when nothing matches; a plain "No events." by default. */
  empty?: ReactNode
  /** Makes each row open its event, as the other admin lists' rows open their item. */
  selection?: { selectedId: string | null; onSelect: (eventId: string) => void }
}

/** Audit events matching `filters`, newest first, with "Load more". */
export const AuditEventList = ({ filters, renderDetails, empty, selection }: AuditEventListProps) => {
  const { t } = useLingui()
  const summaryText = useEventSummaryText()
  const list = useAuditEventList(filters)

  if (list.isLoading) {
    return <ListSkeleton variant={selection ? 'card' : 'flat'} />
  }
  if (list.error && list.items.length === 0) {
    return <InlineError error={list.error} />
  }
  if (list.isEmpty) {
    return (
      empty ?? (
        <SettingsNoResults>
          <Trans>No events.</Trans>
        </SettingsNoResults>
      )
    )
  }

  const selectableRow = (
    event: AuditEvent,
    { selectedId, onSelect }: NonNullable<AuditEventListProps['selection']>,
  ) => (
    <li key={event.id}>
      <SettingsSelectableRow
        ariaLabel={t`Open ${summaryText(event)}`}
        isSelected={selectedId === event.id}
        onSelect={() => onSelect(event.id)}
        title={summaryText(event)}
        subtitle={
          <span className="space-x-2">
            <EventTime event={event} />
            <EventDetails event={event} />
          </span>
        }
        trailingIcon={<OutcomeBadge event={event} />}
      />
    </li>
  )

  const flatRow = (event: AuditEvent) => (
    <li key={event.id} className="flex flex-col gap-0.5 py-2.5">
      {/* A title line over a muted detail line, as a settings row reads. */}
      <div className="flex min-w-0 items-center gap-2">
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--font-size-sm)] text-muted-foreground">
          <EventSummary event={event} />
          <OutcomeBadge event={event} />
        </p>
        <EventTime
          event={event}
          className="shrink-0 text-[length:var(--font-size-xs)] font-normal text-muted-foreground"
        />
      </div>
      {hasDetails(event) && (
        <p className="flex min-w-0 items-center gap-x-2 truncate text-[length:var(--font-size-xs)] text-muted-foreground">
          <EventDetails event={event} />
        </p>
      )}
      {renderDetails?.(event)}
    </li>
  )

  return (
    <div className="flex flex-col gap-2">
      {selection ? (
        <ul className="flex flex-col gap-4">{list.items.map((event) => selectableRow(event, selection))}</ul>
      ) : (
        <ul className="flex flex-col divide-y">{list.items.map(flatRow)}</ul>
      )}
      <InlineError error={list.error} />
      <LoadMoreFooter hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} />
    </div>
  )
}
