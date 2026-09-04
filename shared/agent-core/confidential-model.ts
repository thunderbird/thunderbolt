/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toError, type AgentHarness } from '@earendil-works/pi-agent-core'
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
import { inferenceUsageReceiptHeader, type InferenceUsageReceiptRequest } from '../inference-usage.ts'
import { buildOpenAiCompatModel, type OpenAiCompatFetch } from './openai-compat-model.ts'

const vendorAliases = { zhipu: 'zai' } as const
const modelAliases = { 'glm-5-2': 'glm-5.2' } as const

/** Stable structural codes surfaced by confidential model construction and transport. */
export type ConfidentialModelErrorCode = 'compatibility-missing' | 'attestation-failed'

/** Secret-free confidential model error with a machine-readable structural code. */
export type ConfidentialModelError<Code extends ConfidentialModelErrorCode = ConfidentialModelErrorCode> = Error & {
  readonly code: Code
}

/** Provider response receipt paired with the exact terminal message that owns its usage. */
export type CompletedProviderStep = {
  readonly receipt: string
  readonly message: AssistantMessage
}

/** Stages provider receipts and correlates them after attachment to one harness. */
export type ReceiptLifecycle = {
  readonly completeProviderStep: (step: CompletedProviderStep) => void
  readonly clear: () => void
  /** Attach terminal-message correlation; the returned cleanup detaches it and clears pending state. */
  readonly attach: (harness: Pick<AgentHarness, 'subscribe'>) => () => void
}

/** Provider-facing half of a receipt lifecycle, before harness event correlation. */
export type ReceiptCapture = Pick<ReceiptLifecycle, 'completeProviderStep' | 'clear'>

/** Transport and error-reporting dependencies for a receipt lifecycle. */
export type CreateReceiptLifecycleOptions = {
  /** Submit mapped usage through the caller-owned transport. */
  readonly submit: (usage: InferenceUsageReceiptRequest) => Promise<void>
  /** Observe receipt-transport failures without throwing or altering the model result. */
  readonly reportError: (error: Error) => void
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
  /** Provider-facing capture half of the caller-owned receipt lifecycle. */
  readonly receipts: ReceiptCapture
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

/** Add receipt capture while preserving every caller-supplied stream option. */
const responseCapturingOptions = (
  options: StreamOptions | undefined,
  setReceipt: (receipt: string | null) => void,
): StreamOptions => ({
  ...options,
  onResponse: async (response, responseModel) => {
    setReceipt(new Headers(response.headers).get(inferenceUsageReceiptHeader))
    await options?.onResponse?.(response, responseModel)
  },
})

/** Forward one provider stream while staging only its successful terminal receipt. */
const captureProviderReceipt = (
  source: AssistantMessageEventStream,
  model: Model<Api>,
  getReceipt: () => string | null,
  receipts: ReceiptCapture,
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
          const receipt = getReceipt()
          if (receipt) {
            receipts.completeProviderStep({ receipt, message: event.message })
          } else {
            receipts.clear()
          }
        } else if (event.type === 'error') {
          terminal = true
          receipts.clear()
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
      receipts.clear()
      const error = takeAttestationFailure() ?? new Error('Provider stream ended without a terminal message.')
      const failed = failedProviderMessage(model, error, signal?.aborted === true)
      output.push({ type: 'error', reason: failed.stopReason === 'aborted' ? 'aborted' : 'error', error: failed })
    } catch (error) {
      receipts.clear()
      const failed = failedProviderMessage(model, takeAttestationFailure() ?? toError(error), signal?.aborted === true)
      output.push({ type: 'error', reason: failed.stopReason === 'aborted' ? 'aborted' : 'error', error: failed })
    }
  }
  void forward()
  return output
}

/** Wrap an OpenAI-compatible provider at the provider-stream seam. */
const createReceiptCapturingProvider = (
  provider: Provider,
  receipts: ReceiptCapture,
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
    let receipt: string | null = null
    clearAttestationFailure()
    const source = sourceStream(
      model,
      context,
      responseCapturingOptions(options, (value) => {
        receipt = value
      }),
    )
    return captureProviderReceipt(source, model, () => receipt, receipts, takeAttestationFailure, options?.signal)
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

/** Check that a provider token count is safe to submit. */
export const isNonnegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Map one terminal Pi message to the backend's receipt accounting contract. */
const toReceiptUsage = (step: CompletedProviderStep): InferenceUsageReceiptRequest | null => {
  const { input, cacheRead, cacheWrite, output, totalTokens } = step.message.usage
  const promptTokens = input + cacheRead + cacheWrite
  if (
    step.receipt.length === 0 ||
    !isNonnegativeSafeInteger(input) ||
    !isNonnegativeSafeInteger(cacheRead) ||
    !isNonnegativeSafeInteger(cacheWrite) ||
    !isNonnegativeSafeInteger(promptTokens) ||
    !isNonnegativeSafeInteger(output) ||
    !isNonnegativeSafeInteger(totalTokens)
  ) {
    return null
  }
  return { receipt: step.receipt, promptTokens, completionTokens: output, totalTokens }
}

/** Correlate provider receipts with the exact terminal assistant event that owns their usage. */
export const createReceiptLifecycle = (options: CreateReceiptLifecycleOptions): ReceiptLifecycle => {
  let pending: CompletedProviderStep | null = null
  const clear = (): void => {
    pending = null
  }
  const completeProviderStep = (step: CompletedProviderStep): void => {
    pending = step
  }
  const attach: ReceiptLifecycle['attach'] = (harness) => {
    const unsubscribeHarness = harness.subscribe(async (event) => {
      if (event.type === 'abort' || event.type === 'agent_end' || event.type === 'settled') {
        clear()
        return
      }
      if (event.type !== 'message_end' || pending === null) {
        return
      }

      const completed = pending
      if (event.message !== completed.message) {
        return
      }
      clear()
      if (completed.message.stopReason === 'error' || completed.message.stopReason === 'aborted') {
        return
      }

      const usage = toReceiptUsage(completed)
      if (usage === null) {
        return
      }
      try {
        await options.submit(usage)
      } catch (error) {
        options.reportError(toError(error))
      }
    })
    let subscribed = true
    return () => {
      if (!subscribed) {
        return
      }
      subscribed = false
      unsubscribeHarness()
      clear()
    }
  }
  return { completeProviderStep, clear, attach }
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
    contextWindow: options.contextWindow,
    supportsImages: options.supportsImages,
    compat: compatible.compat,
    thinkingLevelMap: compatible.thinkingLevelMap,
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
    createReceiptCapturingProvider(
      sourceProvider,
      options.receipts,
      () => {
        attestationFailure = null
      },
      takeAttestationFailure,
    ),
  )
  return built
}
