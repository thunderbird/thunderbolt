/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useNavigate, useSearchParams } from 'react-router'
import type { AuditEventQuery } from '@shared/admin-api'
import { auditLogPath, parseAuditLogSearch } from '../../api/audit-log-url'
import { AdminPage } from '../../components/admin-page'
import { AuditEventList } from '../../components/audit-event-list'
import { AuditLogFilterChips, AuditLogFiltersButton } from './audit-log-filters'

/** The org's audit log, newest first. The filters live in the URL, so other screens can link to a view. */
export const AuditLogPage = () => {
  const { t } = useLingui()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const filters = parseAuditLogSearch(params)
  const setFilters = (next: AuditEventQuery) => navigate(auditLogPath(next), { replace: true })

  return (
    <AdminPage title={t`Audit log`} action={<AuditLogFiltersButton filters={filters} onChange={setFilters} />}>
      <AuditLogFilterChips filters={filters} onChange={setFilters} />
      <AuditEventList filters={filters} emptyMessage={<Trans>No events match these filters.</Trans>} />
    </AdminPage>
  )
}
