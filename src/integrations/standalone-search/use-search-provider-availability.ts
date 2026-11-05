/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery as usePowerSyncQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useDatabase } from '@/contexts'
import { getAllModels } from '@/dal/models'
import { useTinfoilConnection } from '@/hooks/use-tinfoil-connection'
import { hasConfiguredTinfoilSearch, hasTinfoilSearchConnection } from '@/integrations/tinfoil-search/eligibility'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { hasOtariSearchConnection } from '@/integrations/otari-search/eligibility'

/** Shares local-provider eligibility between search settings and passive preview routing. */
export const useSearchProviderAvailability = () => {
  const db = useDatabase()
  const custom = useSearchProviderStore(({ provider, apiKey }) => Boolean(provider && apiKey))
  const otariConnection = useSearchProviderStore((state) => state.otariConnection)
  const models = usePowerSyncQuery({
    queryKey: ['models', 'search-providers'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const session = useTinfoilConnection()
  const oauthAvailable = Boolean(session.data?.enabled && session.data.connected && !session.data.needsReauth)
  return {
    custom,
    otari: hasOtariSearchConnection(models.data ?? [], otariConnection),
    otariConfigured: Boolean(otariConnection),
    tinfoil: hasTinfoilSearchConnection(models.data ?? [], oauthAvailable),
    tinfoilConfigured: hasConfiguredTinfoilSearch(models.data ?? [], Boolean(session.data)),
    loading: models.isLoading || session.isLoading,
    // A failed lookup must not be interpreted as permission to fall back to the server.
    ready: models.isSuccess && session.isSuccess && !models.isFetching && !session.isFetching,
  }
}
