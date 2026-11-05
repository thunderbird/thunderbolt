/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'

/** A user model can supply its BYOK search credential; tool calling is an independent model capability. */
export const canSupplyTinfoilSearch = (model: Model): boolean =>
  model.provider === 'tinfoil' &&
  model.isSystem !== 1 &&
  !model.deletedAt &&
  model.enabled === 1 &&
  !model.oauthProvider &&
  Boolean(model.apiKey)

/** OAuth search belongs to the connection, independently of the model list. */
export const hasTinfoilSearchConnection = (models: Model[], oauthAvailable: boolean): boolean =>
  oauthAvailable || models.some(canSupplyTinfoilSearch)

/** Retains the user's private-provider intent while its credentials are disabled or disconnected. */
export const hasConfiguredTinfoilSearch = (models: Model[], oauthConfigured: boolean): boolean =>
  oauthConfigured || models.some((model) => model.provider === 'tinfoil' && model.isSystem !== 1 && !model.deletedAt)
