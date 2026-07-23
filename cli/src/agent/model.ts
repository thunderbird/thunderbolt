/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Resolves built-in Pi catalog models and custom OpenAI-compatible models. */

import type { Api, Model, Models, MutableModels, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { buildOpenAiCompatModel } from './openai-compat-model.ts'
import { builtinProviderEnvVars, defaultProvider, hasProviderEnvKey } from './defaults.ts'
import type { BuiltinProvider, ModelProvider } from './types.ts'

/** Inputs for {@link resolveModel}: model id plus provider routing. */
export type ResolveModelOptions = {
  /** Catalog id for built-ins, or upstream id for openai-compat. */
  readonly model: string
  /** Backend to resolve against (defaults to `anthropic`). */
  readonly provider?: ModelProvider
  /** OpenAI-compatible base URL — required for `openai-compat`. */
  readonly baseUrl?: string
  /** Explicit api key for any provider. */
  readonly apiKey?: string
}

/** Injectable runtime inputs for deterministic model-resolution tests. */
export type ResolveModelDependencies = {
  readonly builtinModels: () => MutableModels
  readonly env: Readonly<Record<string, string | undefined>>
}

const defaultDependencies: ResolveModelDependencies = { builtinModels, env: process.env }

type ProviderRequestModel = Pick<Model<Api>, 'api' | 'provider'>

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
  if (model.provider === 'anthropic' && model.api === 'anthropic-messages') {
    return appendNativeTool(payload, { name: 'web_search', type: 'web_search_20250305' })
  }
  if (model.provider === 'openai' && model.api === 'openai-responses') {
    return appendNativeTool(payload, { type: 'web_search' })
  }
  return payload
}

/** Replaces selected provider streams with key-injecting delegates. */
const applyApiKeyOverride = (models: MutableModels, providerId: BuiltinProvider, apiKey: string): void => {
  const provider = models.getProvider(providerId)
  if (!provider) throw new Error(`Pi catalog does not contain provider "${providerId}".`)

  const baseStream: ProviderStreams['stream'] = provider.stream
  const stream: Provider['stream'] = (model, context, options) => baseStream(model, context, { ...options, apiKey })

  models.setProvider({
    ...provider,
    stream,
    streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, apiKey }),
  })
}

/** Resolves one built-in provider model and validates available credentials. */
const resolveBuiltin = (
  provider: BuiltinProvider,
  requestedId: string,
  apiKey: string | undefined,
  dependencies: ResolveModelDependencies,
): { models: Models; model: Model<Api> } => {
  const envVars = builtinProviderEnvVars[provider]
  if (!apiKey && !hasProviderEnvKey(provider, dependencies.env)) {
    throw new Error(
      `No API key configured for provider "${provider}". Set ${envVars.join(' or ')}, pass --api-key, or run ` +
        '`thunderbolt` in a terminal for guided setup.',
    )
  }

  const models = dependencies.builtinModels()
  const model = models.getModel(provider, requestedId)
  if (!model) {
    const validIds = models
      .getModels(provider)
      .slice(0, 5)
      .map((candidate) => candidate.id)
    throw new Error(
      `Unknown model "${requestedId}" for provider "${provider}". Valid model ids include: ${validIds.join(', ')}.`,
    )
  }

  if (apiKey) applyApiKeyOverride(models, provider, apiKey)
  return { models, model }
}

/** Resolves an OpenAI-compatible model, requiring custom endpoint inputs. */
const resolveOpenAiCompat = (opts: ResolveModelOptions): { models: Models; model: Model<Api> } => {
  if (!opts.apiKey) {
    throw new Error(
      'The openai-compat provider requires an API key. Set THUNDERBOLT_OPENAI_COMPAT_KEY, pass --api-key, ' +
        'or run `thunderbolt` in a terminal for guided setup.',
    )
  }
  if (!opts.baseUrl) {
    throw new Error('The openai-compat provider requires --base-url.')
  }
  return buildOpenAiCompatModel({ modelId: opts.model, baseUrl: opts.baseUrl, apiKey: opts.apiKey })
}

/**
 * Builds provider collection and resolves requested model for harness use.
 * Explicit keys are injected at provider dispatch, after Pi's env resolution,
 * so they win without changing ambient credential behavior.
 */
export const resolveModel = (
  opts: ResolveModelOptions,
  dependencies: ResolveModelDependencies = defaultDependencies,
): { models: Models; model: Model<Api> } => {
  const provider = opts.provider ?? defaultProvider
  if (provider === 'openai-compat') return resolveOpenAiCompat(opts)
  return resolveBuiltin(provider, opts.model, opts.apiKey, dependencies)
}
