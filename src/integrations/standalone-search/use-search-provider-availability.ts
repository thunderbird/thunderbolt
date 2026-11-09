/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useProviderVisibility } from '@/providers/use-provider-visibility'
import { useQuery } from '@powersync/tanstack-react-query'
import { useQueries } from '@tanstack/react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts'
import { getProviderConnections, resolveProviderConnection } from '@/dal/provider-connections'
import { loadOtariSearchStatus } from '@/integrations/otari-search/capabilities'
import { getProviderDefinition } from '@/providers/registry'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { canSupplySearch } from './eligibility'

/** Shares credential-free connection metadata between onboarding, settings and passive previews. */
export const useSearchProviderAvailability = () => {
  const db = useDatabase()
  const { isProviderVisible, otariEnabled } = useProviderVisibility()
  const { selection, connectionId } = useSearchProviderStore()
  const query = useQuery({
    queryKey: ['provider-connections', 'search'],
    query: toCompilableQuery(getProviderConnections(db)),
  })
  const candidates = (query.data ?? []).filter(
    (connection) =>
      isProviderVisible(connection.provider) &&
      getProviderDefinition(connection.provider).capabilities.includes('search'),
  )
  const otari = candidates.filter((connection) => connection.provider === 'otari' && canSupplySearch(connection))
  const capabilities = useQueries({
    queries: otari.map((connection) => ({
      queryKey: ['otari-search-capability', connection.id, connection.updatedAt],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const resolved = await resolveProviderConnection(db, connection.id)
        return loadOtariSearchStatus(resolved.connection.url!, resolved.apiKey, signal)
      },
      staleTime: 30_000,
      retry: false,
    })),
  })
  const connections = candidates.filter((connection) => {
    if (connection.provider !== 'otari') {
      return true
    }
    const capability = capabilities[otari.findIndex(({ id }) => id === connection.id)]
    return capability?.data === 'available' && !capability.isError
  })
  const selectedConnection = connections.find(({ id }) => id === connectionId)
  const connectionAvailable = Boolean(selectedConnection && canSupplySearch(selectedConnection))
  const hasSearchProvider = selection === 'connection' && connectionAvailable
  const hasBuiltInSearch =
    hasSearchProvider && (selectedConnection?.provider === 'tinfoil' || selectedConnection?.provider === 'otari')
  const discovering = capabilities.some((capability) => capability.isPending)
  return {
    otariEnabled,
    connections,
    configuredConnections: candidates,
    selectedConnection,
    connectionAvailable,
    hasSearchProvider,
    hasBuiltInSearch,
    loading: query.isLoading || discovering,
    ready: query.isSuccess && !query.isFetching && !discovering,
  }
}
