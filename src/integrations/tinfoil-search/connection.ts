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

/** Discovers a connected Tinfoil search provider without making network requests or copying credentials. */
export const getTinfoilSearchConnection = async (db: AnyDrizzleDatabase, createApi = createTinfoilWebApi) => {
  const session = await getIntegrationCredentials(db, 'tinfoil')
  if (session?.enabled && session.credentials.access_token && !session.credentials.reauth_required) {
    return { tinfoilSearchApi: createApi(() => tinfoilSession.getAccessToken()), tinfoilConfigured: true }
  }
  const models = await getAllModels(db)
  const tinfoilConfigured = hasConfiguredTinfoilSearch(models, session !== null)
  const model = models.find(canSupplyTinfoilSearch)
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
