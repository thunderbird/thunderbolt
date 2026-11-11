/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { t } from '@lingui/core/macro'

import { getAllModels, getModel } from '@/dal/models'
import { getIntegrationCredentials } from '@/dal/integrations'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { tinfoilSession } from '@/lib/tinfoil-session'
import { canSupplyTinfoilSearch, hasConfiguredTinfoilSearch } from './eligibility'
import { createTinfoilWebApi } from './api'

/** Reads only local connection/model state; no SDK, token refresh, or network work. */
const readTinfoilSearchState = async (db: AnyDrizzleDatabase) => {
  const session = await getIntegrationCredentials(db, 'tinfoil')
  if (session?.enabled && session.credentials.access_token && !session.credentials.reauth_required) {
    return { oauthAvailable: true, model: undefined, tinfoilConfigured: true }
  }
  const models = await getAllModels(db)
  return {
    oauthAvailable: false,
    model: models.find(canSupplyTinfoilSearch),
    tinfoilConfigured: hasConfiguredTinfoilSearch(models, session !== null),
  }
}

/** Rechecks live provider eligibility without constructing a per-turn search API. */
export const getTinfoilSearchAvailability = async (db: AnyDrizzleDatabase) => {
  const { oauthAvailable, model, tinfoilConfigured } = await readTinfoilSearchState(db)
  return { tinfoil: oauthAvailable || Boolean(model), tinfoilConfigured }
}

/** Discovers a connected Tinfoil search provider without making network requests or copying credentials. */
export const getTinfoilSearchConnection = async (db: AnyDrizzleDatabase, createApi = createTinfoilWebApi) => {
  const { oauthAvailable, model, tinfoilConfigured } = await readTinfoilSearchState(db)
  if (oauthAvailable) {
    return { tinfoilSearchApi: createApi(() => tinfoilSession.getAccessToken()), tinfoilConfigured }
  }
  if (!model) {
    return { tinfoilSearchApi: undefined, tinfoilConfigured }
  }
  const tinfoilSearchApi = createApi(async () => {
    // A running turn must honor a subsequent disable/disconnect instead of retaining an old key.
    const current = await getModel(db, model.id)
    if (!current || !canSupplyTinfoilSearch(current)) {
      throw new Error(t`Tinfoil search is no longer connected or enabled.`)
    }
    return current.apiKey!
  })
  return { tinfoilSearchApi, tinfoilConfigured }
}
