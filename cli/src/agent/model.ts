/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Builds stable BYOK models and provider-native request features. */

import { envApiKeyAuth } from '@earendil-works/pi-ai'
import type { Api, Model, Models, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import {
  createCredentialedFetch,
  withCredentialedFetch,
  type CredentialedFetch,
  type CredentialResponseObserver,
} from './credentialed-fetch.ts'
import type { BuiltinProvider } from './types.ts'

const nativeBuiltinProvider = Symbol('nativeBuiltinProvider')

type ProviderRequestModel = Pick<Model<Api>, 'api' | 'provider'> & {
  readonly [nativeBuiltinProvider]?: BuiltinProvider
}

/** True when unknown payload value is a string-keyed object. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Append one provider-native tool without changing unsupported payload shapes. */
const appendNativeTool = (payload: unknown, tool: Readonly<Record<string, string>>): unknown => {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload
  const alreadyPresent = payload.tools.some(
    (candidate) => isRecord(candidate) && candidate.type === tool.type && candidate.name === tool.name,
  )
  if (alreadyPresent) return payload
  return { ...payload, tools: [...payload.tools, tool] }
}

/** Add server-side web search only for provider APIs whose installed SDK supports it. */
export const configureNativeWebSearch = (model: ProviderRequestModel, payload: unknown): unknown => {
  const provider = model[nativeBuiltinProvider] ?? model.provider
  if (provider === 'anthropic' && model.api === 'anthropic-messages') {
    return appendNativeTool(payload, { name: 'web_search', type: 'web_search_20250305' })
  }
  if (provider === 'openai' && model.api === 'openai-responses') {
    return appendNativeTool(payload, { type: 'web_search' })
  }
  return payload
}

/** Inputs for cloning one Pi built-in model into a stable BYOK profile owner. */
export type BuildBuiltinProfileModelOptions = {
  readonly profileId: string
  readonly provider: BuiltinProvider
  readonly modelId: string
  readonly apiKey: string
  readonly fetchFn?: CredentialedFetch
  readonly observeResponse?: CredentialResponseObserver
  readonly modelApi?: Extract<Api, 'anthropic-messages' | 'openai-completions'>
}

/** Stable-profile provider and model pair ready for a prepared binding. */
export type BuiltinProfileModel = {
  readonly provider: Provider
  readonly model: Model<Api>
}

/**
 * Clone one built-in provider/model pair under a stable profile id while
 * binding every stream call to the already-resolved profile credential.
 */
export const buildBuiltinProfileModel = (
  options: BuildBuiltinProfileModelOptions,
  sourceModels: Models = builtinModels(),
): BuiltinProfileModel => {
  const sourceProvider = sourceModels.getProvider(options.provider)
  if (!sourceProvider) throw new Error(`Pi catalog does not contain provider "${options.provider}".`)

  const providerModels = sourceModels.getModels(options.provider)
  const catalogModel = sourceModels.getModel(options.provider, options.modelId)
  const providerApis = new Set(providerModels.map(({ api }) => api))
  if (!catalogModel && providerApis.size > 1 && !options.modelApi) {
    throw new Error(`Unknown mixed-protocol model "${options.modelId}" requires an explicit API format.`)
  }
  const templateModel =
    catalogModel ?? (options.modelApi ? providerModels.find(({ api }) => api === options.modelApi) : providerModels[0])
  if (!templateModel) throw new Error(`Pi catalog does not contain models for "${options.provider}".`)
  const sourceModel: Model<Api> = catalogModel
    ? catalogModel
    : { ...templateModel, id: options.modelId, name: options.modelId }

  const model: Model<Api> = { ...sourceModel, provider: options.profileId }
  Object.defineProperty(model, nativeBuiltinProvider, { value: options.provider })
  const baseStream: ProviderStreams['stream'] = sourceProvider.stream
  const baseStreamSimple: ProviderStreams['streamSimple'] = sourceProvider.streamSimple
  const credentialOrigin = sourceModel.baseUrl || sourceProvider.baseUrl
  if (!credentialOrigin) throw new Error(`Pi catalog provider "${options.provider}" has no base URL.`)
  const credentialedFetch = createCredentialedFetch(
    credentialOrigin,
    options.fetchFn,
    options.observeResponse,
  )

  const provider: Provider = {
    ...sourceProvider,
    id: options.profileId,
    baseUrl: credentialOrigin,
    auth: { apiKey: envApiKeyAuth(`${options.profileId} API key`, []) },
    getModels: () => [model],
    refreshModels: undefined,
    stream: (resolved, context, streamOptions) =>
      withCredentialedFetch(credentialedFetch, () =>
        baseStream({ ...resolved, provider: options.provider }, context, {
          ...streamOptions,
          apiKey: options.apiKey,
        }),
      ),
    streamSimple: (resolved, context, streamOptions) =>
      withCredentialedFetch(credentialedFetch, () =>
        baseStreamSimple({ ...resolved, provider: options.provider }, context, {
          ...streamOptions,
          apiKey: options.apiKey,
        }),
      ),
  }

  return { provider, model }
}
