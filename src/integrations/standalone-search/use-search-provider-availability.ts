/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts'
import { getProviderConnections } from '@/dal/provider-connections'
import { getProviderDefinition } from '@/providers/registry'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { canSupplySearch } from './eligibility'

/** Shares credential-free connection metadata between onboarding, settings and passive previews. */
export const useSearchProviderAvailability = () => {
  const db = useDatabase()
  const { selection, connectionId, connectionStatus } = useSearchProviderStore()
  const query = useQuery({
    queryKey: ['provider-connections', 'search'],
    query: toCompilableQuery(getProviderConnections(db)),
  })
  const connections = (query.data ?? []).filter((connection) =>
    getProviderDefinition(connection.provider).capabilities.includes('search'),
  )
  const selectedConnection = connections.find(({ id }) => id === connectionId)
  const connectionAvailable = Boolean(selectedConnection && canSupplySearch(selectedConnection))
  const hasSearchProvider = selection === 'connection' && connectionAvailable
  const hasBuiltInSearch =
    hasSearchProvider &&
    (selectedConnection?.provider === 'tinfoil' ||
      (selectedConnection?.provider === 'otari' &&
        connectionStatus?.connectionId === connectionId &&
        connectionStatus.status === 'available'))
  return {
    connections,
    selectedConnection,
    connectionAvailable,
    hasSearchProvider,
    hasBuiltInSearch,
    loading: query.isLoading,
    ready: query.isSuccess && !query.isFetching,
  }
}
