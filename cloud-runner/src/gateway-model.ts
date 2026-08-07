/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Keeps a harness's model requests authenticated with the session owner's
 * *current* bearer.
 *
 * `buildHarness` resolves the model once and freezes the api key handed to it,
 * but a session outlives the connection that created it: reconnects bring a
 * fresher token, and the frozen one eventually expires. Rebuilding the harness
 * per bearer change would be correct (all session state lives in the disk entry
 * log) but heavy, so the provider's stream entry points are replaced with
 * delegates that read the bearer at request time instead — Pi resolves the
 * provider per request, so the swap takes effect immediately, including
 * mid-turn.
 *
 * The delegates call Pi's raw `openai-completions` stream rather than wrapping
 * the existing provider (the `applyApiKeyOverride` pattern in
 * `cli/src/agent/model.ts`): that provider re-applies its own frozen api key to
 * the options it is handed, so wrapping it would silently discard the bearer.
 *
 * Documented reliance (re-verify on `@earendil-works/pi-ai` bumps): Pi's
 * `openai-completions` client sends `options.apiKey` as the `Authorization:
 * Bearer` header to `${model.baseUrl}/chat/completions`, which is exactly the
 * backend inference gateway's contract.
 */

import {
  createProvider,
  hasApi,
  type Api,
  type Model,
  type Models,
  type MutableModels,
  type ProviderStreams,
} from '@earendil-works/pi-ai'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

/** Provider id `resolveModel`'s `openai-compat` branch registers the gateway
 *  model under (see `cli/src/agent/openai-compat-model.ts`). */
const gatewayProviderId = 'openai-compat'

const completionsApi = 'openai-completions'

const requireCompletionsModel = (model: Model<Api>): Model<typeof completionsApi> => {
  if (!hasApi(model, completionsApi)) {
    throw new Error(`the gateway model must be an "${completionsApi}" model, got "${model.api}"`)
  }
  return model
}

/** `AgentHarness` publishes its collection as the read-only `Models` view, but
 *  Pi only ever constructs mutable ones (`createModels()`), so this widens a
 *  view rather than assuming anything about the object — verified at runtime. */
const requireMutable = (models: Models): MutableModels => {
  const mutable = models as MutableModels
  if (typeof mutable.setProvider !== 'function') {
    throw new Error('the harness model collection is immutable; the gateway bearer cannot be rebound')
  }
  return mutable
}

/**
 * Rebind `models`' gateway provider so every model request authenticates with
 * the bearer `readBearer()` returns at that moment.
 *
 * @param models - the harness's provider collection, mutated in place
 * @param readBearer - yields the bearer for the next model request
 */
export const bindGatewayBearer = (models: Models, readBearer: () => string): void => {
  const mutable = requireMutable(models)
  const provider = mutable.getProvider(gatewayProviderId)
  if (!provider) {
    throw new Error(`the harness model collection has no "${gatewayProviderId}" provider`)
  }
  const api: ProviderStreams = {
    stream: (model, context, options) =>
      stream(requireCompletionsModel(model), context, { ...options, apiKey: readBearer() }),
    streamSimple: (model, context, options) =>
      streamSimple(requireCompletionsModel(model), context, { ...options, apiKey: readBearer() }),
  }
  mutable.setProvider(
    createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      auth: provider.auth,
      models: [...provider.getModels()],
      api,
    }),
  )
}
