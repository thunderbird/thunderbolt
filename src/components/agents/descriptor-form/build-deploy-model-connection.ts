/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turns a selected account model into the {@link DeployModelConnection} a deploy
 * sends, so the sandbox knows how to dial the model. Managed models omit the key
 * (the backend mints a token and overrides the base URL); BYOK models carry the
 * provider base URL + the user's key (read from the local-only secrets join).
 * Mirrors the provider mapping in `resolveOpenAiCompatConnection` (src/ai/fetch.ts).
 */

import { getModel } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import type { Model } from '@/types'
import type { DeployModelConnection } from '@shared/agent-descriptors'
import {
  byokProviderConfig,
  isFixedByokProvider,
  isManagedProvider,
  managedProvider,
} from '@shared/agent-model-connection'

/** The model fields needed to resolve a deploy connection. */
type DeployableModel = Pick<Model, 'provider' | 'model' | 'url' | 'apiKey'>

/**
 * Map a model to its deploy connection, or `undefined` when it isn't deployable
 * (tinfoil, or a `custom` model with no URL). Pure — unit-tested directly.
 */
export const mapModelToDeployConnection = (model: DeployableModel): DeployModelConnection | undefined => {
  const { provider } = model
  if (isManagedProvider(provider)) {
    return { provider: managedProvider, model: model.model, baseUrl: '', compatibility: 'openai' }
  }
  if (isFixedByokProvider(provider)) {
    const { baseUrl, compatibility } = byokProviderConfig[provider]
    return { provider, model: model.model, baseUrl, compatibility, apiKey: model.apiKey ?? undefined }
  }
  if (provider === 'custom' && model.url) {
    return {
      provider: 'custom',
      model: model.model,
      baseUrl: normalizeOpenAiBaseUrl(model.url),
      compatibility: 'openai',
      apiKey: model.apiKey ?? undefined,
    }
  }
  return undefined
}

/**
 * Load the selected model (including its local-only apiKey) and resolve the
 * deploy connection the sandbox dials. Returns `undefined` for a missing or
 * non-deployable model.
 */
export const buildDeployModelConnection = async (
  db: AnyDrizzleDatabase,
  modelId: string,
): Promise<DeployModelConnection | undefined> => {
  const model = await getModel(db, modelId)
  return model ? mapModelToDeployConnection(model) : undefined
}
