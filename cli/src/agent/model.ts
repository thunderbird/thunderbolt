/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Resolves built-in Pi catalog models and custom OpenAI-compatible models. */

import type {
  Api,
  Model,
  Models,
  MutableModels,
  Provider,
  ProviderStreams,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { buildOpenAiCompatModel } from './openai-compat-model.ts'
import { BUILTIN_PROVIDER_ENV_VARS, DEFAULT_PROVIDER } from './defaults.ts'
import type { BuiltinProvider, ModelProvider } from './types.ts'

export { BUILTIN_PROVIDER_ENV_VARS } from './defaults.ts'

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

const DEFAULT_DEPENDENCIES: ResolveModelDependencies = { builtinModels, env: process.env }

/** Replaces selected provider streams with key-injecting delegates. */
const applyApiKeyOverride = (models: MutableModels, providerId: BuiltinProvider, apiKey: string): void => {
  const provider = models.getProvider(providerId)
  if (!provider) throw new Error(`Pi catalog does not contain provider "${providerId}".`)

  const baseStream: ProviderStreams['stream'] = provider.stream
  const stream: Provider['stream'] = (model, context, options) =>
    baseStream(model, context, { ...options, apiKey })

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
  const envVars = BUILTIN_PROVIDER_ENV_VARS[provider]
  const hasEnvKey = envVars.some((name) => Boolean(dependencies.env[name]))
  if (!apiKey && !hasEnvKey) {
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
      'The openai-compat provider requires an api key. Set THUNDERBOLT_OPENAI_COMPAT_KEY, pass --api-key, ' +
        'or run `thunderbolt` in a terminal for guided setup.',
    )
  }
  if (!opts.baseUrl) {
    throw new Error('the openai-compat provider requires --base-url')
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
  dependencies: ResolveModelDependencies = DEFAULT_DEPENDENCIES,
): { models: Models; model: Model<Api> } => {
  const provider = opts.provider ?? DEFAULT_PROVIDER
  if (provider === 'openai-compat') return resolveOpenAiCompat(opts)
  return resolveBuiltin(provider, opts.model, opts.apiKey, dependencies)
}
