/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProviderConnection, getProviderCredentials, resolveProviderConnection } from '@/dal/provider-connections'
import { getSettings } from '@/dal/settings'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createOtariWebApi } from '@/integrations/otari-search/api'
import { loadOtariWebCapabilities } from '@/integrations/otari-search/capabilities'
import { createTinfoilWebApi } from '@/integrations/tinfoil-search/api'
import type { WebToolApi } from '@/integrations/thunderbolt-pro/tools'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { createMcpSearchApi } from './mcp-api'
import { createStandaloneWebApi } from './api'
import { isSearchProvider } from './providers'
import { canSupplySearch } from './eligibility'
import type { ProviderType } from '@/providers/types'
import { getIdentitySignal } from '@/lib/identity-lifetime'

/** Applies preview visibility to execution without changing the saved search selection. */
const isSearchProviderEnabled = async (db: AnyDrizzleDatabase, provider: ProviderType) =>
  provider !== 'otari' || (await getSettings(db, { experimental_feature_otari: false })).experimentalFeatureOtari

/** Pins a turn to one authorization while allowing its OAuth token to refresh normally. */
export const getSearchConnectionAuthorization = async (db: AnyDrizzleDatabase, connectionId: string) => {
  const signal = getIdentitySignal()
  const connection = await getProviderConnection(db, connectionId)
  signal.throwIfAborted()
  if (!connection || !canSupplySearch(connection) || !(await isSearchProviderEnabled(db, connection.provider))) {
    return null
  }
  const credentials = await getProviderCredentials(db, connectionId)
  if (!credentials) {
    return null
  }

  /** Checks both sides of credential resolution, which can wait for an OAuth refresh. */
  const assertProviderEnabled = async () => {
    signal.throwIfAborted()
    if (!(await isSearchProviderEnabled(db, connection.provider))) {
      throw new Error('Otari preview is disabled. Enable it in Settings to use this connection.')
    }
    signal.throwIfAborted()
  }
  const getApiKey = async () => {
    await assertProviderEnabled()
    const live = await resolveProviderConnection(db, connectionId)
    await assertProviderEnabled()
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
  return { connection, getApiKey, signal }
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
  if (connection.authMethod === 'oauth' && (connection.provider === 'exa' || connection.provider === 'tavily')) {
    return createMcpSearchApi(connection.provider, getApiKey)
  }
  if (connection.provider === 'tinfoil') {
    return createTinfoilWebApi(getApiKey)
  }
  if (connection.provider === 'otari' && connection.url) {
    const capabilities = await loadOtariWebCapabilities(connection.url, await getApiKey(), authorization.signal)
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
