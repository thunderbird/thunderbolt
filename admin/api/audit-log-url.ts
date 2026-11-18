/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AuditEventQuery, AuditOutcome } from '@shared/admin-api'

/** The audit filters a link to the audit log can carry. Paging stays out of the URL. */
type AuditLogFilters = Omit<AuditEventQuery, 'cursor' | 'limit'>

const filterNames = ['action', 'outcome', 'actorId', 'targetType', 'targetId', 'connectionId', 'from', 'to'] as const

const outcomes: readonly AuditOutcome[] = ['success', 'failure', 'denied']

const isOutcome = (value: string): value is AuditOutcome => (outcomes as readonly string[]).includes(value)

/** The audit log, filtered by `query`: e.g. a connection's SCIM sync errors. Read back with `parseAuditLogSearch`. */
export const auditLogPath = (query: AuditEventQuery = {}): string => {
  const params = new URLSearchParams()
  for (const name of filterNames) {
    const value = query[name]
    if (value) {
      params.set(name, value)
    }
  }
  const search = params.toString()
  return search ? `/admin/audit-log?${search}` : '/admin/audit-log'
}

/** The audit filters in an audit-log URL's search, as `auditLogPath` writes them. Unknown or invalid values are dropped. */
export const parseAuditLogSearch = (search: string | URLSearchParams): AuditLogFilters => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const filters: AuditLogFilters = {}
  for (const name of filterNames) {
    const value = params.get(name)
    if (!value) {
      continue
    }
    if (name === 'outcome') {
      if (isOutcome(value)) {
        filters.outcome = value
      }
      continue
    }
    filters[name] = value
  }
  return filters
}
