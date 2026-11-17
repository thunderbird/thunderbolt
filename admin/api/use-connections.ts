/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useQuery } from '@tanstack/react-query'
import type { AdminConnection } from '@shared/admin-api'
import { adminQueryKeys } from './query-keys'
import { useAdminApi } from './use-admin-api'

/** The org's identity connections. Not paged: an org has few. `select` derives a view from the one cached list. */
export const useConnections = <T = AdminConnection[]>(select?: (connections: AdminConnection[]) => T) => {
  const api = useAdminApi()
  return useQuery({ queryKey: adminQueryKeys.connections.list(), queryFn: () => api.connections.list(), select })
}
