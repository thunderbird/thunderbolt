/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getProviderById, getProviderCredentials } from '@/dal/providers'
import type { Model } from '@/types'

/**
 * Hydrate a provider-backed model's credential + base URL before it reaches
 * `createModel`. Models with a `providerId` resolve their key from the local
 * `providers_secrets` table (not the deprecated inline `modelsTable.apiKey`) and
 * their base URL from the provider row, so the existing `src/ai/fetch.ts`
 * provider-enum dispatch routes them through `/v1/proxy` unchanged.
 *
 * Models without a `providerId` (system/backend and legacy custom rows) are
 * returned untouched.
 */
export const hydrateProviderModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  model: Model,
): Promise<Model> => {
  if (!model.providerId) {
    return model
  }
  const [provider, credentials] = await Promise.all([
    getProviderById(db, workspaceId, model.providerId),
    getProviderCredentials(db, model.providerId),
  ])
  return {
    ...model,
    apiKey: credentials?.apiKey ?? credentials?.access_token ?? model.apiKey,
    url: provider?.baseUrl ?? model.url,
  }
}
