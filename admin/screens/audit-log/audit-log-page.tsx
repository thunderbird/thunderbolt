/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ScrollText } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { EmptyState } from '@/components/ui/empty-state'
import { useDebounce } from '@/hooks/use-debounce'
import type { AuditEventQuery } from '@shared/admin-api'
import { auditLogPath, parseAuditLogSearch } from '../../api/audit-log-url'
import { searchDebounceMs } from '../../api/search-debounce'
import { AdminPage } from '../../components/admin-page'
import { AuditEventList, useAuditEventList } from '../../components/audit-event-list'
import { useResourcePageState } from '../../components/use-resource-page-state'
import { AuditEventPanel } from './audit-event-panel'
import { AuditLogFilterChips, AuditLogFiltersButton } from './audit-log-filters'

/**
 * The org's audit log, newest first. The search and filters live in the URL, so other screens can link
 * to a view. The search box owns `q`; the filter controls own the rest and leave it as it is. The open
 * event is component state, as every admin screen's open item is.
 */
export const AuditLogPage = () => {
  const { t } = useLingui()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const page = useResourcePageState()
  const { q, ...filters } = parseAuditLogSearch(params)
  const searched = useDebounce(q, searchDebounceMs)
  const query = { ...filters, q: searched }
  const go = (next: AuditEventQuery) => navigate(auditLogPath(next), { replace: true })
  const setFilters = (next: AuditEventQuery) => go({ ...next, q })
  const setSearch = (value: string) => go({ ...filters, q: value.trim() || undefined })
  const isFiltered = Object.values(query).some(Boolean)
  const list = useAuditEventList(query)

  return (
    <AdminPage
      title={t`Audit Log`}
      search={{ placeholder: t`Search events`, onSearch: setSearch, defaultValue: q }}
      isEmpty={!isFiltered && list.isEmpty}
      action={<AuditLogFiltersButton filters={filters} onChange={setFilters} />}
      onClose={page.close}
      panel={
        page.selectedId && <AuditEventPanel key={page.selectedId} eventId={page.selectedId} onClose={page.close} />
      }
    >
      <AuditLogFilterChips filters={filters} onChange={setFilters} />
      <AuditEventList
        filters={query}
        selection={{ selectedId: page.selectedId, onSelect: page.requestSelect }}
        empty={
          isFiltered ? (
            <SettingsNoResults>
              <Trans>No matching events.</Trans>
            </SettingsNoResults>
          ) : (
            <EmptyState icon={ScrollText} title={t`No events yet`} />
          )
        }
      />
    </AdminPage>
  )
}
