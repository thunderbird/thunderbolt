/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { AuditEvent, Page } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useConnections } from '../../api/use-connections'
import { useAdminApi } from '../../api/use-admin-api'

/** What an audit event's panel reads: the event, with its actor and target named, and its connection's name. */
export const useAuditEventPanelState = (eventId: string) => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  const event = useQuery({
    queryKey: adminQueryKeys.auditEvents.detail(eventId),
    queryFn: () => api.auditEvents.get(eventId),
    // A loaded page of the log already holds the event, so the panel opens on it rather than a skeleton.
    placeholderData: () =>
      queryClient
        .getQueriesData<InfiniteData<Page<AuditEvent>>>({ queryKey: adminQueryKeys.auditEvents.lists })
        .flatMap(([, data]) => data?.pages.flatMap((page) => page.items) ?? [])
        .find((item) => item.id === eventId),
  })
  const connectionId = event.data?.connectionId ?? null
  const connectionName = useConnections(
    (connections) => connections.find((connection) => connection.id === connectionId)?.name ?? null,
  )
  return { event, connectionName: connectionName.data ?? null }
}

export type AuditEventPanelState = ReturnType<typeof useAuditEventPanelState>
