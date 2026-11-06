/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProviderConnection, getProviderCredentials, resolveProviderConnection } from '@/dal/provider-connections'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createOtariWebApi } from '@/integrations/otari-search/api'
import { loadOtariWebCapabilities } from '@/integrations/otari-search/capabilities'
import { createTinfoilWebApi } from '@/integrations/tinfoil-search/api'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { createStandaloneWebApi } from './api'
import { isSearchProvider } from './providers'
import { canSupplySearch } from './eligibility'

/** Pins a turn to one authorization while allowing its OAuth token to refresh normally. */
export const getSearchConnectionAuthorization = async (db: AnyDrizzleDatabase, connectionId: string) => {
  const connection = await getProviderConnection(db, connectionId)
  const credentials = await getProviderCredentials(db, connectionId)
  if (!connection || !canSupplySearch(connection) || !credentials) {
    return null
  }

  const getApiKey = async () => {
    const live = await resolveProviderConnection(db, connectionId)
    if (
      !canSupplySearch(live.connection) ||
      live.connection.provider !== connection.provider ||
      live.connection.authMethod !== connection.authMethod ||
      live.connection.url !== connection.url ||
      live.revision !== credentials.sessionRevision
    ) {
      throw new Error('Search connection changed or was disconnected. Start a new turn after reconnecting.')
    }
    return live.apiKey
  }
  return { connection, getApiKey }
}

/** Builds only the selected connection's API; Otari capabilities are discovered again for every turn. */
export const getSearchConnectionApi = async (
  db: AnyDrizzleDatabase,
  connectionId: string,
): Promise<WebToolApi | undefined> => {
  const authorization = await getSearchConnectionAuthorization(db, connectionId)
  if (!authorization) {
    return undefined
  }
  const { connection } = authorization
  const getApiKey = async () => {
    const apiKey = await authorization.getApiKey()
    const current = useSearchProviderStore.getState()
    if (current.selection !== 'connection' || current.connectionId !== connectionId) {
      throw new Error('Search provider changed or was disconnected. Start a new turn to use the current provider.')
    }
    return apiKey
  }
  if (connection.provider === 'tinfoil') {
    return createTinfoilWebApi(getApiKey)
  }
  if (connection.provider === 'otari' && connection.url) {
    const capabilities = await loadOtariWebCapabilities(connection.url, await getApiKey(), new AbortController().signal)
    if (capabilities.search !== 'available') {
      return undefined
    }
    const api = createOtariWebApi(connection.url, getApiKey)
    return capabilities.fetch === 'available' ? api : { ...api, fetchContent: undefined }
  }
  return isSearchProvider(connection.provider)
    ? createStandaloneWebApi(getApiKey, undefined, connection.provider)
    : undefined
}
