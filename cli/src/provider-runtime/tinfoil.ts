/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { vendorSupportsImages, type SharedModel } from '../../../shared/defaults/models.ts'
import {
  buildConfidentialModel,
  isConfidentialModelError,
  resolveConfidentialModelCompatibility,
} from '../../../shared/agent-core/confidential-model.ts'
import { inferenceModelHeader } from '../../../shared/inference-usage.ts'
import { join } from 'node:path'
import { SecureClient } from 'tinfoil'
import { apiBaseUrl, backendHeaders, isSecureCloudUrl } from '../auth/config.ts'
import { thunderboltHomeDir } from '../paths.ts'
import { providerRuntimeError } from './types.ts'
import type { AccountFetch, PreparedPiBinding, ProviderRuntimeError, SessionCredential } from './types.ts'
import { createUsageReceiptLifecycle, submitInferenceUsageReceipt } from './usage-receipt.ts'

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

/** Encode the validated 256-bit installation secret in Tinfoil's expected lower-case form. */
const cacheSecretHex = (secret: Uint8Array): string => Buffer.from(secret).toString('hex')

/** Replace every caller-controlled auth header with the stored session bearer. */
const authenticatedSecureFetch =
  (
    credential: SessionCredential,
    model: string,
    getClient: () => SecureClient | null,
    observeStatus: (status: number) => void,
  ): AccountFetch =>
  async (input, init) => {
    const client = getClient()
    if (client === null) throw new Error('Tinfoil binding is disposed.')
    const headers = backendHeaders(init?.headers)
    headers.set(inferenceModelHeader, model)
    headers.delete('authorization')
    headers.delete('x-api-key')
    headers.set('authorization', `Bearer ${credential.bearer}`)
    const response = await client.fetch(input instanceof Request ? input.url : String(input), { ...init, headers })
    observeStatus(response.status)
    return response
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
  try {
    resolveConfidentialModelCompatibility({ modelId: options.model.model, vendor: options.model.vendor })
  } catch (error) {
    if (error instanceof Error && isConfidentialModelError(error, 'compatibility-missing')) {
      throw invalidTinfoilConfigError(error.message)
    }
    throw error
  }

  const baseUrl = `${apiBaseUrl(options.credential.backendUrl)}/tinfoil`
  const createSecureClient = options.createSecureClient ?? ((clientOptions) => new SecureClient(clientOptions))
  let client: SecureClient | null = createSecureClient({
    baseURL: baseUrl,
    userCacheSecret: cacheSecretHex(options.credential.userCacheSecret),
  })
  let storedSessionUnauthorized = false
  const fetchFn = authenticatedSecureFetch(
    options.credential,
    options.model.model,
    () => client,
    (status) => {
      storedSessionUnauthorized = status === 401 || status === 403
    },
  )

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
  const built = buildConfidentialModel({
    providerId,
    modelId: options.model.model,
    vendor: options.model.vendor,
    baseURL: baseUrl,
    apiKey: sdkPlaceholderCredential,
    fetch: fetchFn,
    receipts,
    reasoning: true,
    contextWindow: options.model.contextWindow ?? undefined,
    supportsImages: vendorSupportsImages(options.model.vendor),
  })
  const provider = built.models.getProvider(providerId)
  if (!provider) throw new Error('Tinfoil provider construction failed.')
  const dispose: PreparedPiBinding['dispose'] = async () => {
    receipts.clear()
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
