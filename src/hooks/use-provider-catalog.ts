/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useDatabase } from '@/contexts'
import { useFetch } from '@/lib/proxy-fetch-context'
import { getProviderCredentials, type Provider } from '@/dal/providers'
import { listProviderModels, type CatalogModel } from '@/lib/providers/validate'

/**
 * Fetch a provider's live model catalog (its `/models` list) on demand — the
 * "thousands of models" that are NOT stored as rows (spec.md §3). Cached in
 * memory by React Query, keyed by provider id. Routed through the proxy-aware
 * `useFetch()` so it works on web (via `/v1/proxy`) and desktop (direct).
 */
export const useProviderModelCatalog = (provider: Provider | null): UseQueryResult<CatalogModel[]> => {
  const db = useDatabase()
  const proxyFetch = useFetch()
  return useQuery({
    queryKey: ['provider-catalog', provider?.id],
    enabled: !!provider,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const credentials = await getProviderCredentials(db, provider!.id)
      return listProviderModels(
        provider!.type,
        { apiKey: credentials?.apiKey ?? credentials?.access_token, baseUrl: provider!.baseUrl ?? undefined },
        proxyFetch,
      )
    },
  })
}
