/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { t } from '@lingui/core/macro'
import { getModel } from '@/dal/models'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { canSupplyOtariSearch } from './eligibility'
import { createOtariWebApi } from './api'
import { loadOtariWebCapabilities } from './capabilities'

/** Reads the registered model so search follows model removal, disable, and credential changes. */
const readOtariSearchState = async (db: AnyDrizzleDatabase) => {
  const connection = useSearchProviderStore.getState().otariConnection
  const model = connection ? await getModel(db, connection.modelId) : null
  return { connection, model: model && canSupplyOtariSearch(model, connection) ? model : null }
}

/** Checks local availability without making a paid search request. */
export const getOtariSearchAvailability = async (db: AnyDrizzleDatabase) => {
  const { connection, model } = await readOtariSearchState(db)
  return { otari: Boolean(model), otariConfigured: Boolean(connection) }
}

/** Reuses the OAuth model's key, checking the live connection before every gateway request. */
export const getOtariSearchConnection = async (db: AnyDrizzleDatabase, createApi = createOtariWebApi) => {
  const { connection, model } = await readOtariSearchState(db)
  const otariConfigured = Boolean(connection)
  if (!connection || !model) {
    return { otariSearchApi: undefined, otariConfigured }
  }
  const getApiKey = async () => {
    const current = await readOtariSearchState(db)
    if (
      current.connection?.modelId !== connection.modelId ||
      current.connection.url !== connection.url ||
      !current.model ||
      current.model.apiKey !== model.apiKey
    ) {
      throw new Error(t`Otari search changed or was disconnected. Start a new turn after reconnecting.`)
    }
    return current.model.apiKey!
  }
  const capabilities = await loadOtariWebCapabilities(connection.url, await getApiKey(), new AbortController().signal)
  if (capabilities.search !== 'available') {
    return { otariSearchApi: undefined, otariConfigured }
  }
  const api = createApi(connection.url, getApiKey)
  return {
    otariSearchApi: capabilities.fetch === 'available' ? api : { ...api, fetchContent: undefined },
    otariConfigured,
  }
}
