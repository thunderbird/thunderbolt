/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { useFormatters } from '@/i18n/use-formatters'
import type { AuditEvent } from '@shared/admin-api'
import {
  actorTypeLabels,
  auditActionName,
  auditTargetTypeName,
  outcomeLabels,
  outcomeTones,
  readableClient,
} from '../../components/audit-event-labels'
import { InlineError } from '../../components/inline-error'
import { ListSkeleton } from '../../components/list-skeleton'
import { StatusBadge } from '../../components/status-badge'
import { useHour12 } from '../../components/use-hour12'
import { auditItemLink } from './audit-item-link'
import { auditDataEntries, auditFieldChanges, formatAuditValue } from './audit-event-data'
import { useAuditEventPanelState } from './use-audit-event-panel-state'

const valueClass = 'break-words text-base leading-snug text-foreground'
const secondaryClass = 'break-all text-[length:var(--font-size-sm)] text-muted-foreground'

type EventPartyProps = {
  /** The raw actor or target type, which picks the screen a link opens. */
  type: string
  /** The type's readable name. */
  typeName: string
  id: string | null
  /** Its name, when the server knows one; only a named item links, since an unnamed one is gone or not a member. */
  label: string | null
}

/** Who or what the event names: its name, linked to its own screen when it has one, over its type and raw id. */
const EventParty = ({ type, typeName, id, label }: EventPartyProps) => {
  const link = label && id ? auditItemLink(type, id) : null
  return (
    <>
      <p className={valueClass}>
        {link ? (
          <Link {...link} className="underline">
            {label}
          </Link>
        ) : (
          (label ?? typeName)
        )}
      </p>
      {(label || id) && (
        <p className={secondaryClass}>
          {label && typeName}
          {label && id && ' · '}
          {id && <code>{id}</code>}
        </p>
      )}
    </>
  )
}

/** What the event changed, as `field: from → to`, read from the `{ field: { from, to } }` shape writers use. */
const ChangesField = ({ changes }: { changes: unknown }) => {
  const fieldChanges = auditFieldChanges(changes)
  if (fieldChanges) {
    return (
      <DetailField label={<Trans>Changes</Trans>}>
        <dl className="flex flex-col gap-1 text-base leading-snug">
          {fieldChanges.map(({ field, from, to }) => (
            <div key={field} className="flex flex-wrap gap-x-2">
              <dt>
                <code>{field}</code>
              </dt>
              <dd className="break-all text-foreground">
                {formatAuditValue(from)} → {formatAuditValue(to)}
              </dd>
            </div>
          ))}
        </dl>
      </DetailField>
    )
  }
  return <DataField label={<Trans>Changes</Trans>} data={changes} />
}

/** Free-form event data: each key with its value, or the whole value as JSON when it isn't keyed. */
const DataField = ({ label, data }: { label: ReactNode; data: unknown }) => {
  const entries = auditDataEntries(data)
  return (
    <DetailField label={label}>
      {entries ? (
        <dl className="flex flex-col gap-1 text-base leading-snug">
          {entries.map(([key, value]) => (
            <div key={key} className="flex flex-wrap gap-x-2">
              <dt>
                <code>{key}</code>
              </dt>
              <dd className="break-all text-foreground">{formatAuditValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-[length:var(--font-size-sm)]">
          <code>{JSON.stringify(data, null, 2)}</code>
        </pre>
      )}
    </DetailField>
  )
}

/** Whether a recorded value is worth a row: anything but null or undefined. */
const hasData = (value: unknown) => value !== null && value !== undefined

type AuditEventViewProps = { event: AuditEvent; connectionName: string | null; onClose: () => void }

/** One audit event, read-only: how it went, when, who did it to what, from where, and what it recorded. */
const AuditEventView = ({ event, connectionName, onClose }: AuditEventViewProps) => {
  const { t, i18n } = useLingui()
  const formatters = useFormatters()
  const hour12 = useHour12()
  const client = event.userAgent ? readableClient(i18n, event.userAgent) : null

  return (
    <DetailPanel title={auditActionName(i18n, event.action)} onClose={onClose}>
      <DetailField label={<Trans>Outcome</Trans>}>
        <div>
          <StatusBadge tone={outcomeTones[event.outcome]}>{i18n._(outcomeLabels[event.outcome])}</StatusBadge>
        </div>
        {event.reason && (
          <p className={secondaryClass}>
            <code>{event.reason}</code>
          </p>
        )}
      </DetailField>
      <DetailField label={<Trans>Time</Trans>}>
        <p className={valueClass}>
          <time dateTime={event.occurredAt}>
            {formatters.date(event.occurredAt)} {formatters.time(event.occurredAt, { hour12 })}
          </time>
        </p>
        <p className={secondaryClass}>{formatters.relativeTime(event.occurredAt)}</p>
      </DetailField>
      <DetailDivider />
      <DetailField label={<Trans>Actor</Trans>}>
        <EventParty
          type={event.actorType}
          typeName={i18n._(actorTypeLabels[event.actorType])}
          id={event.actorId}
          label={event.actorLabel}
        />
      </DetailField>
      {event.targetType && (
        <DetailField label={<Trans>Target</Trans>}>
          <EventParty
            type={event.targetType}
            typeName={auditTargetTypeName(i18n, event.targetType)}
            id={event.targetId}
            label={event.targetLabel}
          />
        </DetailField>
      )}
      {event.connectionId && (
        <DetailField label={<Trans>Connection</Trans>}>
          <EventParty
            type="identity_connection"
            typeName={t`Identity provider`}
            id={event.connectionId}
            label={connectionName}
          />
        </DetailField>
      )}
      {(event.userAgent || event.ipAddress) && <DetailDivider />}
      {event.userAgent && (
        <DetailField label={<Trans>Client</Trans>}>
          {client && <p className={valueClass}>{client}</p>}
          <p className={client ? secondaryClass : `${valueClass} break-all font-mono`}>{event.userAgent}</p>
        </DetailField>
      )}
      {event.ipAddress && (
        <DetailField label={<Trans>IP address</Trans>}>
          <p className={`${valueClass} font-mono`}>{event.ipAddress}</p>
        </DetailField>
      )}
      {(hasData(event.changes) || hasData(event.metadata)) && <DetailDivider />}
      {hasData(event.changes) && <ChangesField changes={event.changes} />}
      {hasData(event.metadata) && <DataField label={<Trans>Details</Trans>} data={event.metadata} />}
      <DetailDivider />
      <DetailField label={<Trans>Recorded by</Trans>}>
        <p className={valueClass}>{event.reportSource === 'client' ? t`The app` : t`The server`}</p>
        {event.requestId && (
          <p className={secondaryClass}>
            <Trans>
              Request <code>{event.requestId}</code>
            </Trans>
          </p>
        )}
        {event.credentialId && (
          <p className={secondaryClass}>
            <Trans>
              Credential <code>{event.credentialId}</code>
            </Trans>
          </p>
        )}
      </DetailField>
    </DetailPanel>
  )
}

type AuditEventPanelProps = { eventId: string; onClose: () => void }

/** The open audit event's panel, read-only: it has no actions, so no ⋯ menu. */
export const AuditEventPanel = ({ eventId, onClose }: AuditEventPanelProps) => {
  const { t } = useLingui()
  const { event, connectionName } = useAuditEventPanelState(eventId)

  if (!event.data) {
    return (
      <DetailPanel title={t`Event`} onClose={onClose}>
        {event.error ? <InlineError error={event.error} /> : <ListSkeleton rows={3} variant="flat" />}
      </DetailPanel>
    )
  }
  return <AuditEventView event={event.data} connectionName={connectionName} onClose={onClose} />
}
