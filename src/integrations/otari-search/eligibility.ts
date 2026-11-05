/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OtariSearchConnection } from '@/stores/search-provider-store'
import type { Model } from '@/types'

/** Matches the model that owns the saved Otari connection without inferring identity from a custom URL. */
export const belongsToOtariConnection = (model: Model, connection: OtariSearchConnection | null): boolean =>
  connection !== null &&
  model.id === connection.modelId &&
  model.url === connection.url &&
  model.provider === 'otari' &&
  model.isSystem !== 1 &&
  !model.deletedAt &&
  !model.oauthProvider &&
  Boolean(model.apiKey)

/** Local eligibility for discovery; cached capability failures must not prevent a later recheck. */
export const canSupplyOtariSearch = (model: Model, connection: OtariSearchConnection | null): boolean =>
  belongsToOtariConnection(model, connection) && model.enabled === 1

/** Shares the saved OAuth connection with onboarding and search settings without copying its key. */
export const hasOtariSearchConnection = (models: Model[], connection: OtariSearchConnection | null): boolean =>
  models.some((model) => canSupplyOtariSearch(model, connection))
