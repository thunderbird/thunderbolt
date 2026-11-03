/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { t } from '@lingui/core/macro'

import { getAllModels, getModel } from '@/dal/models'
import { getIntegrationCredentials } from '@/dal/integrations'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { tinfoilSession } from '@/lib/tinfoil-session'
import { usesLocalProviders } from '@/lib/provider-mode'
import type { Model } from '@/types'
import { createTinfoilWebApi } from './api'

/** Only enabled user connections may supply standalone search; managed billing stays server-owned. */
export const canSupplyTinfoilSearch = (model: Model): boolean =>
  model.provider === 'tinfoil' &&
  model.isSystem !== 1 &&
  !model.deletedAt &&
  model.enabled === 1 &&
  model.toolUsage !== 0 &&
  Boolean(model.oauthProvider === 'tinfoil' || model.apiKey)

/** Shares credential eligibility between the settings UI and runtime tool discovery. */
export const findTinfoilSearchModel = (models: Model[], oauthAvailable: boolean) => {
  const candidates = models.filter(canSupplyTinfoilSearch)
  return (
    candidates.find((model) => model.oauthProvider === 'tinfoil' && oauthAvailable) ??
    candidates.find((model) => !model.oauthProvider && model.apiKey)
  )
}

/** Discovers a connected Tinfoil search provider without making network requests or copying credentials. */
export const getTinfoilWebApi = async (db: AnyDrizzleDatabase, createApi = createTinfoilWebApi) => {
  if (!usesLocalProviders()) {
    return undefined
  }
  const models = (await getAllModels(db)).filter(canSupplyTinfoilSearch)
  const session = models.some((model) => model.oauthProvider === 'tinfoil')
    ? await getIntegrationCredentials(db, 'tinfoil')
    : null
  const oauthAvailable = Boolean(
    session?.enabled && session.credentials.access_token && !session.credentials.reauth_required,
  )
  const model = findTinfoilSearchModel(models, oauthAvailable)
  if (!model) {
    return undefined
  }
  return createApi(async () => {
    // A running turn must honor a subsequent disable/disconnect instead of retaining an old key.
    const current = await getModel(db, model.id)
    if (!current || !canSupplyTinfoilSearch(current)) {
      throw new Error(t`Tinfoil search is no longer connected or enabled.`)
    }
    return current.oauthProvider === 'tinfoil' ? tinfoilSession.getAccessToken() : current.apiKey!
  })
}
