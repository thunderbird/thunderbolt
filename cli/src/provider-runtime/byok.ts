/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { buildOpenAiCompatModel } from '../../../shared/agent-core/openai-compat-model.ts'
import { builtinProviderEnvVars } from '../agent/defaults.ts'
import type { CredentialResponseObserver } from '../agent/credentialed-fetch.ts'
import { createCredentialedFetch, getUncredentialedFetch } from '../agent/credentialed-fetch.ts'
import { buildBuiltinProfileModel } from '../agent/model.ts'
import {
  noopBindingLifecycle,
  providerRuntimeError,
  type ByokProfile,
  type InvocationSelection,
  type PreparedPiBinding,
  type ProviderRuntimeError,
} from './types.ts'

type ByokBindingError = Error & ProviderRuntimeError

type ResolvedByokCredential = {
  readonly apiKey: string
  readonly persistsCredentialStatus: boolean
}

const openAiCompatEnvironmentKey = 'THUNDERBOLT_OPENAI_COMPAT_KEY'

/** Creates a BYOK binding error carrying the requested code and message. */
const createByokBindingError = (
  code: Extract<ProviderRuntimeError['code'], 'authentication-required' | 'model-not-found' | 'config-invalid'>,
  message: string,
): ByokBindingError => providerRuntimeError(code, message)

/** Accepts credentials containing non-whitespace while preserving their original bytes. */
const usableCredential = (value: string | undefined | null): string | null =>
  value && value.trim().length > 0 ? value : null

/** Returns only environment variables dedicated to the selected provider. */
const dedicatedEnvironmentNames = (profile: ByokProfile): readonly string[] =>
  profile.provider === 'openai-compat' ? [openAiCompatEnvironmentKey] : builtinProviderEnvVars[profile.provider]

/** Selects the first usable dedicated environment credential in provider-defined order. */
const environmentCredential = (
  profile: ByokProfile,
  environment: Readonly<Record<string, string | undefined>>,
): string | null =>
  dedicatedEnvironmentNames(profile)
    .map((name) => usableCredential(environment[name]))
    .find((value): value is string => value !== null) ?? null

/** Explains when an endpoint override makes a stored OpenAI-compatible key unsafe to reuse. */
const missingCredentialMessage = (profile: ByokProfile, effectiveBaseUrl?: string): string => {
  const environmentNames = dedicatedEnvironmentNames(profile).join(' or ')
  if (
    profile.provider === 'openai-compat' &&
    effectiveBaseUrl !== profile.baseUrl &&
    profile.apiKey !== null &&
    profile.credentialStatus === 'authenticated'
  ) {
    return (
      `The stored key for profile "${profile.id}" is scoped to ${profile.baseUrl} and cannot be sent to ` +
      `${effectiveBaseUrl}. Pass --api-key or set ${openAiCompatEnvironmentKey}.`
    )
  }
  return (
    `No API key is available for BYOK profile "${profile.id}". Set ${environmentNames}, pass --api-key, ` +
    'or repair the profile in `thunderbolt config`.'
  )
}

/** Enforces flag, dedicated environment, then endpoint-scoped stored-key precedence without fallback. */
const resolveCredential = (
  profile: ByokProfile,
  selection: InvocationSelection,
  environment: Readonly<Record<string, string | undefined>>,
  effectiveBaseUrl?: string,
): ResolvedByokCredential => {
  const explicit = usableCredential(selection.apiKey)
  if (explicit) return { apiKey: explicit, persistsCredentialStatus: false }

  const fromEnvironment = environmentCredential(profile, environment)
  if (fromEnvironment) return { apiKey: fromEnvironment, persistsCredentialStatus: false }

  const stored = usableCredential(profile.apiKey)
  const endpointMatches = profile.provider !== 'openai-compat' || effectiveBaseUrl === profile.baseUrl
  if (stored && endpointMatches) {
    return { apiKey: stored, persistsCredentialStatus: true }
  }

  throw createByokBindingError('authentication-required', missingCredentialMessage(profile, effectiveBaseUrl))
}

/** Wraps a fully resolved Pi provider in the no-op lifecycle used by direct BYOK bindings. */
const createPreparedBinding = (
  profile: ByokProfile,
  model: Model<Api>,
  provider: Provider,
  persistsCredentialStatus: boolean,
): PreparedPiBinding => ({
  providerId: profile.id,
  wireModel: model.id,
  persistsCredentialStatus,
  piModel: model,
  install: (models) => models.setProvider(provider),
  ...noopBindingLifecycle,
})

/** Prepare one built-in or OpenAI-compatible BYOK profile without fallback. */
export const createByokBinding = async (
  profile: ByokProfile,
  selection: InvocationSelection,
  environment: Readonly<Record<string, string | undefined>>,
  observeResponse: CredentialResponseObserver,
): Promise<PreparedPiBinding> => {
  const modelId = selection.model ?? profile.defaultModel
  if (profile.provider === 'openai-compat') {
    const baseUrl = selection.baseUrl ?? profile.baseUrl
    if (baseUrl.length === 0) {
      throw createByokBindingError('config-invalid', `BYOK profile "${profile.id}" requires a base URL.`)
    }
    const credential = resolveCredential(profile, selection, environment, baseUrl)
    const fetch = createCredentialedFetch(baseUrl, getUncredentialedFetch(), observeResponse)
    const built = buildOpenAiCompatModel({
      providerId: profile.id,
      modelId,
      baseURL: baseUrl,
      apiKey: credential.apiKey,
      fetch,
      reasoning: false,
      supportsImages: false,
    })
    const provider = built.models.getProvider(profile.id)
    if (!provider) {
      throw createByokBindingError('config-invalid', 'The OpenAI-compatible Pi provider was not registered.')
    }
    return createPreparedBinding(profile, built.model, provider, credential.persistsCredentialStatus)
  }

  const credential = resolveCredential(profile, selection, environment)
  const sourceModels = builtinModels()
  if (
    profile.provider === 'fireworks' &&
    sourceModels.getModel('fireworks', modelId) === undefined &&
    profile.modelApi === undefined
  ) {
    throw createByokBindingError(
      'authentication-required',
      `Repair BYOK profile "${profile.id}" and choose the Fireworks API format before using model "${modelId}".`,
    )
  }
  const built = buildBuiltinProfileModel(
    {
      profileId: profile.id,
      provider: profile.provider,
      modelId,
      apiKey: credential.apiKey,
      observeResponse,
      modelApi: profile.provider === 'fireworks' ? profile.modelApi : undefined,
    },
    sourceModels,
  )
  return createPreparedBinding(profile, built.model, built.provider, credential.persistsCredentialStatus)
}
