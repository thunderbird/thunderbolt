/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toError } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type ProviderStreams,
  type StreamOptions,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { buildOpenAiCompatModel, type OpenAiCompatFetch } from './openai-compat-model.ts'

import type { ReasoningEffort } from '../reasoning-effort.ts'

const vendorAliases = { zhipu: 'zai' } as const
// pi-ai 0.82.1 has no glm-5.3 and no deepseek-v4-1-flash; swap each alias for the real catalog id when upgrading Pi
const modelAliases = {
  'glm-5-2': 'glm-5.2',
  'glm-5-3': 'glm-5.2',
  'glm-5-3-flash': 'glm-5.2',
  'deepseek-v4-1-flash': 'deepseek-v4-flash',
} as const

/** Stable structural codes surfaced by confidential model construction and transport. */
export type ConfidentialModelErrorCode = 'compatibility-missing' | 'attestation-failed'

/** Secret-free confidential model error with a machine-readable structural code. */
export type ConfidentialModelError<Code extends ConfidentialModelErrorCode = ConfidentialModelErrorCode> = Error & {
  readonly code: Code
}

/** Browser-safe inputs for constructing one catalog-driven confidential Pi model. */
export type BuildConfidentialModelOptions = {
  readonly providerId: string
  /** Catalog model identifier used to resolve Pi compatibility metadata and sent unchanged on the wire. */
  readonly modelId: string
  /** Catalog vendor used to resolve Pi compatibility metadata; null fails construction. */
  readonly vendor: string | null
  readonly baseURL: string
  readonly apiKey: string
  /** Already-attested fetch, wrapped only to normalize attestation failures hidden by Pi. */
  readonly fetch: OpenAiCompatFetch
  readonly getReasoningEffort?: () => ReasoningEffort | undefined
  /** Native effort controls may replace Pi's legacy aliases when paired with an exact payload override. */
  readonly thinkingLevelMap?: Model<'openai-completions'>['thinkingLevelMap']
  readonly reasoning: boolean
  readonly contextWindow?: number
  readonly supportsImages: boolean
}

const confidentialModelError = <Code extends ConfidentialModelErrorCode>(
  code: Code,
  message: string,
): ConfidentialModelError<Code> => Object.assign(new Error(message), { code })

const resolveAlias = (aliases: Readonly<Record<string, string>>, value: string): string => aliases[value] ?? value

/** Identify a shared confidential-model error by its stable structural code. */
export const isConfidentialModelError = <Code extends ConfidentialModelErrorCode>(
  error: Error,
  code?: Code,
): error is ConfidentialModelError<Code> => 'code' in error && (code === undefined || error.code === code)

/** Resolve a confidential catalog row to Pi's provider-specific request metadata. */
export const resolveConfidentialModelCompatibility = (
  model: Pick<BuildConfidentialModelOptions, 'modelId' | 'vendor'>,
): Model<Api> => {
  const provider = model.vendor === null ? null : resolveAlias(vendorAliases, model.vendor)
  const modelId = resolveAlias(modelAliases, model.modelId)
  const resolved = provider === null ? undefined : builtinModels().getModel(provider, modelId)
  if (!resolved) {
    throw confidentialModelError(
      'compatibility-missing',
      `Managed model "${model.modelId}" has no Pi compatibility metadata.`,
    )
  }
  if (model.modelId === 'glm-5-3' || model.modelId === 'glm-5-3-flash') {
    return {
      ...resolved,
      thinkingLevelMap: { ...resolved.thinkingLevelMap, low: 'low', medium: 'high', high: 'high', max: 'max' },
    }
  }
  // Legacy inherited Pi levels use the chat-template compatibility mapping.
  // Explicit native effort uses Tinfoil's documented top-level reasoning_effort
  // via getReasoningEffort; that override removes these legacy fields and aliases.
  if (model.modelId === 'deepseek-v4-1-flash') {
    return {
      ...resolved,
      thinkingLevelMap: { minimal: 'low', low: 'low', medium: 'high', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' },
      compat: {
        ...resolved.compat,
        thinkingFormat: 'chat-template',
        chatTemplateKwargs: {
          thinking: { $var: 'thinking.enabled' },
          reasoning_effort: { $var: 'thinking.effort', omitWhenOff: true },
        },
      },
    }
  }
  return resolved
}

/** Replace enclave measurement details with the stable public failure contract. */
const normalizeAttestationFailure = (error: Error): ConfidentialModelError<'attestation-failed'> | null => {
  if (error.name === 'AttestationError') {
    return confidentialModelError('attestation-failed', 'Confidential model attestation failed.')
  }
  return error.cause instanceof Error ? normalizeAttestationFailure(error.cause) : null
}

/** Create the terminal error required when a provider violates Pi's stream protocol. */
const failedProviderMessage = (model: Model<Api>, error: Error, aborted: boolean): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: aborted ? 'aborted' : 'error',
  errorMessage: error.message,
  timestamp: Date.now(),
})

/** Forward one provider stream, restoring attestation failures and guaranteeing a terminal event. */
const forwardProviderStream = (
  source: AssistantMessageEventStream,
  model: Model<Api>,
  takeAttestationFailure: () => ConfidentialModelError<'attestation-failed'> | null,
  signal?: AbortSignal,
): AssistantMessageEventStream => {
  const output = createAssistantMessageEventStream()
  const forward = async (): Promise<void> => {
    let terminal = false
    try {
      for await (const event of source) {
        if (event.type === 'done') {
          terminal = true
        } else if (event.type === 'error') {
          terminal = true
          const attestationFailure = takeAttestationFailure()
          output.push(
            attestationFailure === null
              ? event
              : { ...event, error: { ...event.error, errorMessage: attestationFailure.message } },
          )
          continue
        }
        output.push(event)
      }
      if (terminal) {
        return
      }
      const error = takeAttestationFailure() ?? new Error('Provider stream ended without a terminal message.')
      const failed = failedProviderMessage(model, error, signal?.aborted === true)
      output.push({ type: 'error', reason: failed.stopReason === 'aborted' ? 'aborted' : 'error', error: failed })
    } catch (error) {
      const failed = failedProviderMessage(model, takeAttestationFailure() ?? toError(error), signal?.aborted === true)
      output.push({ type: 'error', reason: failed.stopReason === 'aborted' ? 'aborted' : 'error', error: failed })
    }
  }
  void forward()
  return output
}

/** Wrap an OpenAI-compatible provider at the provider-stream seam. */
const createAttestationNormalizingProvider = (
  provider: Provider,
  clearAttestationFailure: () => void,
  takeAttestationFailure: () => ConfidentialModelError<'attestation-failed'> | null,
): Provider => {
  const sourceStream: ProviderStreams['stream'] = provider.stream
  const sourceStreamSimple: ProviderStreams['streamSimple'] = provider.streamSimple
  const wrap = (
    sourceStream: ProviderStreams['stream'],
    model: Model<Api>,
    context: Parameters<ProviderStreams['stream']>[1],
    options?: StreamOptions,
  ): AssistantMessageEventStream => {
    clearAttestationFailure()
    return forwardProviderStream(sourceStream(model, context, options), model, takeAttestationFailure, options?.signal)
  }
  const api: ProviderStreams = {
    stream: (model, context, options) => wrap(sourceStream, model, context, options),
    streamSimple: (model, context, options) => wrap(sourceStreamSimple, model, context, options),
  }
  return createProvider({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    headers: provider.headers,
    auth: provider.auth,
    models: provider.getModels(),
    api,
  })
}

/** Build a catalog-driven confidential model over an already-attested fetch. */
export const buildConfidentialModel = (
  options: BuildConfidentialModelOptions,
): ReturnType<typeof buildOpenAiCompatModel> => {
  const compatible = resolveConfidentialModelCompatibility(options)
  let attestationFailure: ConfidentialModelError<'attestation-failed'> | null = null
  const fetch: OpenAiCompatFetch = async (input, init) => {
    try {
      return await options.fetch(input, init)
    } catch (error) {
      const normalized = error instanceof Error ? normalizeAttestationFailure(error) : null
      if (normalized === null) {
        throw error
      }
      attestationFailure = normalized
      throw normalized
    }
  }
  const built = buildOpenAiCompatModel({
    providerId: options.providerId,
    modelId: options.modelId,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    fetch,
    reasoning: options.reasoning,
    contextWindow: options.contextWindow ?? compatible.contextWindow,
    maxTokens: compatible.maxTokens,
    supportsImages: options.supportsImages,
    getReasoningEffort: options.getReasoningEffort,
    effortFormat: 'tinfoil',
    compat: compatible.compat,
    thinkingLevelMap: options.thinkingLevelMap ?? compatible.thinkingLevelMap,
  })
  const sourceProvider = built.models.getProvider(options.providerId)
  if (!sourceProvider) {
    throw new Error('Confidential provider construction failed.')
  }
  const takeAttestationFailure = (): ConfidentialModelError<'attestation-failed'> | null => {
    const failure = attestationFailure
    attestationFailure = null
    return failure
  }
  built.models.setProvider(
    createAttestationNormalizingProvider(
      sourceProvider,
      () => {
        attestationFailure = null
      },
      takeAttestationFailure,
    ),
  )
  return built
}
