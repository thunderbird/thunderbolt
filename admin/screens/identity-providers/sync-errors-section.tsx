/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { Link } from 'react-router'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import type { AuditEvent, AuditEventQuery } from '@shared/admin-api'
import { auditLogPath } from '../../api/audit-log-url'
import { AuditEventList } from '../../components/audit-event-list'
import { parseScimFailure } from './scim-failure-details'

/** The request a failed SCIM event describes: method, resource, status, and the provider-facing error. */
const ScimFailure = ({ event }: { event: AuditEvent }) => {
  const failure = parseScimFailure(event.metadata)
  if (!failure) {
    return null
  }
  const resource = [failure.resourceType, failure.resourceId].filter(Boolean).join('/')
  return (
    <div className="flex flex-col gap-0.5 text-[length:var(--font-size-sm)]">
      <code>
        {failure.method} {resource}
        {failure.status !== null && ` → ${failure.status}`}
      </code>
      {failure.detail && <span className="text-muted-foreground">{failure.detail}</span>}
    </div>
  )
}

/** The connection's recent rejected SCIM requests, from the audit log. */
export const SyncErrorsSection = ({ connectionId }: { connectionId: string }) => {
  const filters: AuditEventQuery = { action: 'scim.request', outcome: 'failure', connectionId }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>Unauthenticated requests aren't listed.</Trans>
      </p>
      <AuditEventList
        filters={filters}
        renderDetails={(event) => <ScimFailure event={event} />}
        empty={
          <SettingsNoResults>
            <Trans>No failed SCIM requests.</Trans>
          </SettingsNoResults>
        }
      />
      <Link to={auditLogPath(filters)} className="text-[length:var(--font-size-sm)] text-primary underline">
        <Trans>See all in the audit log</Trans>
      </Link>
    </div>
  )
}
