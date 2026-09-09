/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { vendorSupportsImages, type SharedModel } from '../../../shared/defaults/models.ts'
import { buildOpenAiCompatModel } from '../../../shared/agent-core/openai-compat-model.ts'
import type { CredentialedFetch, CredentialResponseObserver } from '../agent/credentialed-fetch.ts'
import { createCredentialedFetch, getUncredentialedFetch } from '../agent/credentialed-fetch.ts'
import { apiBaseUrl, backendHeaders, isSecureCloudUrl } from '../auth/config.ts'
import { noopBindingLifecycle, providerRuntimeError } from './types.ts'
import type { AccountFetch, PreparedPiBinding, ProviderRuntimeError, ResolvedAccountCredential } from './types.ts'

type ManagedDirectBindingOptions = {
  readonly credential: ResolvedAccountCredential
  readonly model: SharedModel
  readonly observeResponse: CredentialResponseObserver
  readonly fetchFn?: AccountFetch
}

type DirectBindingError = Error & ProviderRuntimeError

const providerId = 'thunderbolt'
const sdkPlaceholderCredential = 'thunderbolt-account-credential'

/** Create a stable preparation error without exposing account credentials. */
const createDirectBindingError = (
  code: Extract<ProviderRuntimeError['code'], 'config-invalid'>,
  message: string,
): DirectBindingError => providerRuntimeError(code, message)

/** Normalize the sole managed-direct origin from the resolved account credential. */
const resolveDirectBaseUrl = (backendUrl: string): string => {
  if (isSecureCloudUrl(backendUrl)) return apiBaseUrl(backendUrl)
  throw createDirectBindingError(
    'config-invalid',
    'Managed direct backend URL must use https (or loopback http) without credentials, a query, or a fragment',
  )
}

/** Replace every SDK auth header with exactly the resolved account credential. */
const authenticatedFetch =
  (credential: ResolvedAccountCredential, request: CredentialedFetch): CredentialedFetch =>
  async (input, init) => {
    const headers = backendHeaders(init?.headers)
    headers.delete('authorization')
    headers.delete('x-api-key')
    if (credential.type === 'session') {
      headers.set('authorization', `Bearer ${credential.bearer}`)
    } else {
      headers.set('x-api-key', credential.token)
    }

    return request(input, { ...init, headers })
  }

/** Prepare a generic public managed-direct catalog row for the Pi runtime. */
export const createManagedDirectBinding = async (options: ManagedDirectBindingOptions): Promise<PreparedPiBinding> => {
  if (options.model.isConfidential !== 0) {
    throw createDirectBindingError(
      'config-invalid',
      `Managed model "${options.model.model}" does not use the direct transport`,
    )
  }

  const baseUrl = resolveDirectBaseUrl(options.credential.backendUrl)
  const request: CredentialedFetch = options.fetchFn ?? getUncredentialedFetch()
  const fetch = createCredentialedFetch(
    baseUrl,
    authenticatedFetch(options.credential, request),
    options.observeResponse,
  )
  const built = buildOpenAiCompatModel({
    providerId,
    modelId: options.model.model,
    baseURL: baseUrl,
    apiKey: sdkPlaceholderCredential,
    fetch,
    // The catalog has no per-model reasoning flag yet (THU-863).
    reasoning: true,
    contextWindow: options.model.contextWindow!,
    supportsImages: vendorSupportsImages(options.model.vendor),
  })
  const provider = built.models.getProvider(providerId)
  if (!provider) throw new Error('Managed direct provider construction failed')

  return {
    providerId,
    wireModel: options.model.model,
    persistsCredentialStatus: false,
    piModel: built.model,
    install: (models) => models.setProvider(provider),
    ...noopBindingLifecycle,
  }
}
