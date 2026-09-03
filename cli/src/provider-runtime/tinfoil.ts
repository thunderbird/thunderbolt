/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { vendorSupportsImages, type SharedModel } from '../../../shared/defaults/models.ts'
import { buildOpenAiCompatModel } from '../../../shared/agent-core/openai-compat-model.ts'
import { inferenceUsageReceiptHeader, managedGlmIdentity } from '../../../shared/inference-usage.ts'
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
import { builtinModels as piBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { join } from 'node:path'
import { SecureClient } from 'tinfoil'
import { apiBaseUrl, backendHeaders, isSecureCloudUrl } from '../auth/config.ts'
import { thunderboltHomeDir } from '../paths.ts'
import { providerRuntimeError } from './types.ts'
import type { AccountFetch, PreparedPiBinding, ProviderRuntimeError, SessionCredential } from './types.ts'
import { createUsageReceiptLifecycle, submitInferenceUsageReceipt } from './usage-receipt.ts'
import type { UsageReceiptLifecycle } from './usage-receipt.ts'

type TinfoilBindingError = Error & ProviderRuntimeError

const providerId = 'thunderbolt'
const sdkPlaceholderCredential = 'thunderbolt-session'

export type CreateTinfoilBindingOptions = {
  readonly credential: SessionCredential
  readonly model: SharedModel
  readonly onStoredSessionRejected: () => Promise<void>
  readonly fetchFn?: AccountFetch
  readonly receiptTimeoutMs?: number
  readonly receiptOutboxPath?: string
  readonly receiptRetryWait?: (milliseconds: number) => Promise<void>
  readonly reportError?: (error: Error) => void
  readonly createSecureClient?: (options: ConstructorParameters<typeof SecureClient>[0]) => SecureClient
}

/** Build a non-secret preparation error for malformed confidential state. */
const invalidTinfoilConfigError = (message: string): TinfoilBindingError =>
  providerRuntimeError('config-invalid', message)

/** Resolve Pi request semantics from the managed model's own public identity. */
const compatibilityModel = (model: SharedModel): Model<Api> => {
  const provider = model.vendor === 'zhipu' ? 'zai' : model.vendor
  const modelId = model.model === managedGlmIdentity.model ? 'glm-5.2' : model.model
  const resolved = provider === null ? undefined : piBuiltinModels().getModel(provider, modelId)
  if (!resolved) {
    throw invalidTinfoilConfigError(`Managed model "${model.model}" has no Pi compatibility metadata.`)
  }
  return resolved
}

/** Build a stable, non-secret failure for a rejected confidential attestation. */
const attestationFailedError = (): TinfoilBindingError =>
  providerRuntimeError('attestation-failed', 'Confidential model attestation failed.')

/** Replace measurement details with the public runtime error contract. */
const normalizeAttestationFailure = (error: unknown): TinfoilBindingError | null => {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === 'AttestationError') return attestationFailedError()
  }
  return null
}

/** Encode the validated 256-bit installation secret in Tinfoil's expected lower-case form. */
const cacheSecretHex = (secret: Uint8Array): string => Buffer.from(secret).toString('hex')

/** Replace every caller-controlled auth header with the stored session bearer. */
const authenticatedSecureFetch =
  (
    credential: SessionCredential,
    getClient: () => SecureClient | null,
    observeStatus: (status: number) => void,
    observeAttestationFailure: (error: TinfoilBindingError) => void,
  ): AccountFetch =>
  async (input, init) => {
    const client = getClient()
    if (client === null) throw new Error('Tinfoil binding is disposed.')
    const headers = backendHeaders(init?.headers)
    headers.delete('authorization')
    headers.delete('x-api-key')
    headers.set('authorization', `Bearer ${credential.bearer}`)
    try {
      const response = await client.fetch(input instanceof Request ? input.url : String(input), { ...init, headers })
      observeStatus(response.status)
      return response
    } catch (error) {
      const attestationFailure = normalizeAttestationFailure(error)
      if (attestationFailure === null) throw error
      observeAttestationFailure(attestationFailure)
      throw attestationFailure
    }
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

/** Adds receipt capture while preserving every caller-supplied stream option. */
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

/** Forward one Pi provider stream while staging only its successful terminal receipt. */
const captureProviderReceipt = (
  source: AssistantMessageEventStream,
  model: Model<Api>,
  getReceipt: () => string | null,
  receipts: UsageReceiptLifecycle,
  takeAttestationFailure: () => TinfoilBindingError | null,
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
      if (terminal) return
      receipts.clear()
      const attestationFailure = takeAttestationFailure()
      const error = attestationFailure ?? new Error('Provider stream ended without a terminal message.')
      const failed = failedProviderMessage(model, error, signal?.aborted === true)
      output.push({ type: 'error', reason: failed.stopReason === 'aborted' ? 'aborted' : 'error', error: failed })
    } catch (error) {
      receipts.clear()
      const attestationFailure = takeAttestationFailure()
      const failed = failedProviderMessage(model, attestationFailure ?? toError(error), signal?.aborted === true)
      output.push({ type: 'error', reason: failed.stopReason === 'aborted' ? 'aborted' : 'error', error: failed })
    }
  }
  void forward()
  return output
}

/** Wrap the OpenAI-compatible provider at the provider-stream boundary. */
const createReceiptCapturingProvider = (
  provider: Provider,
  receipts: UsageReceiptLifecycle,
  clearAttestationFailure: () => void,
  takeAttestationFailure: () => TinfoilBindingError | null,
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

/** Prepare one session-bound confidential model for the Pi harness. */
export const createTinfoilBinding = async (options: CreateTinfoilBindingOptions): Promise<PreparedPiBinding> => {
  if (
    !(options.credential.userCacheSecret instanceof Uint8Array) ||
    options.credential.userCacheSecret.byteLength !== 32
  ) {
    throw invalidTinfoilConfigError('The confidential cache secret must contain exactly 32 bytes.')
  }
  if (options.model.isConfidential !== 1) {
    throw invalidTinfoilConfigError(`Managed model "${options.model.model}" does not use confidential transport.`)
  }
  if (!isSecureCloudUrl(options.credential.backendUrl)) {
    throw invalidTinfoilConfigError(
      'Confidential backend URL must use https (or loopback http) without credentials, a query, or a fragment.',
    )
  }
  const compatible = compatibilityModel(options.model)

  const baseUrl = `${apiBaseUrl(options.credential.backendUrl)}/tinfoil`
  const createSecureClient = options.createSecureClient ?? ((clientOptions) => new SecureClient(clientOptions))
  let client: SecureClient | null = createSecureClient({
    baseURL: baseUrl,
    userCacheSecret: cacheSecretHex(options.credential.userCacheSecret),
  })
  let storedSessionUnauthorized = false
  let attestationFailure: TinfoilBindingError | null = null
  const takeAttestationFailure = (): TinfoilBindingError | null => {
    const failure = attestationFailure
    attestationFailure = null
    return failure
  }
  const fetchFn = authenticatedSecureFetch(
    options.credential,
    () => client,
    (status) => {
      storedSessionUnauthorized = status === 401 || status === 403
    },
    (error) => {
      attestationFailure = error
    },
  )
  const built = buildOpenAiCompatModel({
    providerId,
    modelId: options.model.model,
    baseURL: baseUrl,
    apiKey: sdkPlaceholderCredential,
    fetch: fetchFn,
    reasoning: true,
    contextWindow: options.model.contextWindow!,
    supportsImages: vendorSupportsImages(options.model.vendor),
    compat: compatible.compat,
    thinkingLevelMap: compatible.thinkingLevelMap,
  })
  const sourceProvider = built.models.getProvider(providerId)
  if (!sourceProvider) throw new Error('Tinfoil provider construction failed.')

  const reportError =
    options.reportError ?? ((error: Error) => console.error('Confidential usage receipt bookkeeping failed.', error))
  const receipts = await createUsageReceiptLifecycle({
    outboxPath:
      options.receiptOutboxPath ??
      join(thunderboltHomeDir(), 'inference-usage-receipts', `${options.credential.deviceId}.json`),
    reportError,
    wait: options.receiptRetryWait,
    submit: (usage) =>
      submitInferenceUsageReceipt({
        backendUrl: options.credential.backendUrl,
        bearer: options.credential.bearer,
        usage,
        fetchFn: options.fetchFn,
        onUnauthorized: options.onStoredSessionRejected,
        reportError,
        timeoutMs: options.receiptTimeoutMs,
      }),
  })
  const provider = createReceiptCapturingProvider(
    sourceProvider,
    receipts,
    () => {
      attestationFailure = null
    },
    takeAttestationFailure,
  )
  const dispose: PreparedPiBinding['dispose'] = async () => {
    receipts.clear()
    attestationFailure = null
    if (client === null) return
    const activeClient = client
    client = null
    activeClient.reset()
  }

  return {
    providerId,
    wireModel: options.model.model,
    persistsCredentialStatus: false,
    piModel: built.model,
    install: (models) => models.setProvider(provider),
    attach: receipts.attach,
    observePromptError: async () => {
      if (!storedSessionUnauthorized) return
      storedSessionUnauthorized = false
      await options.onStoredSessionRejected()
    },
    dispose,
  }
}
