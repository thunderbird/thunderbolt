/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { auditLogPath, parseAuditLogSearch } from '../../api/audit-log-url'
import { adminQueryKeys } from '../../api/query-keys'
import { AdminPage } from '../../components/admin-page'
import { AuditEventList } from '../../components/audit-event-list'
import { AuditLogFilters } from './audit-log-filters'

/** The org's audit log, newest first. The filters live in the URL, so other screens can link to a view. */
export const AuditLogPage = () => {
  const { t } = useLingui()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const filters = parseAuditLogSearch(params)

  return (
    // Refresh sits in the toolbar, not the page header: on phones the header renders its actions in
    // flow, under the scrolling list.
    <AdminPage title={t`Audit log`}>
      <AuditLogFilters
        filters={filters}
        onChange={(next) => navigate(auditLogPath(next), { replace: true })}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.auditEvents.all })}
          >
            <RefreshCw />
            <Trans>Refresh</Trans>
          </Button>
        }
      />
      <AuditEventList filters={filters} emptyMessage={<Trans>No events match these filters.</Trans>} />
    </AdminPage>
  )
}
