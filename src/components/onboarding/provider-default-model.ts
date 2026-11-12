/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ProviderSetupError, runProviderSetupStage } from './provider-setup-error'
import { defaultModelId, defaultModels, type SharedModel } from '@shared/defaults/models'
import { createDefaultProbe } from '@/hooks/use-model-connection-test'
import type { FetchFn } from '@/lib/proxy-fetch'
import { fetchModelsForProvider, type AvailableModel } from '@/settings/models/model-catalog'
import type { AddModelFormValues } from '@/settings/models/use-add-model-form'

export type OnboardingProvider = 'openrouter' | 'tinfoil'
export type ProviderModelValues = AddModelFormValues &
  Pick<
    SharedModel,
    'contextWindow' | 'vendor' | 'isConfidential' | 'supportsParallelToolCalls' | 'startWithReasoning'
  > & {
    providerDefault: 1
  }

/** Ignores only provider namespaces and punctuation, retaining model versions and variants. */
const modelIdentity = (value: string) =>
  value
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** Resolves the shipped agent default to an actual catalog ID, never a guessed endpoint slug. */
export const resolveProviderDefaultModel = (
  catalog: AvailableModel[],
  preferred = defaultModels.find((model) => model.id === defaultModelId)!,
) => {
  const matches = catalog.filter(
    (model) => model.supports_tools !== false && modelIdentity(model.id) === modelIdentity(preferred.model),
  )
  return matches.find((model) => model.id === preferred.model) ?? (matches.length === 1 ? matches[0] : undefined)
}

const dependencies = { fetchModels: fetchModelsForProvider, probe: createDefaultProbe() }

/** Verifies the provider's default model before credentials can be persisted locally. */
export const prepareProviderDefaultModel = async (
  provider: OnboardingProvider,
  apiKey: string,
  getProxyFetch: () => FetchFn,
  signal: AbortSignal,
  deps = dependencies,
): Promise<ProviderModelValues> => {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  const work = async (): Promise<ProviderModelValues> => {
    boundedSignal.throwIfAborted()
    const catalog = await runProviderSetupStage('catalog', () => deps.fetchModels({ provider, apiKey }, getProxyFetch))
    boundedSignal.throwIfAborted()
    const model = resolveProviderDefaultModel(catalog)
    if (!model) {
      throw new ProviderSetupError('model')
    }
    const preferred = defaultModels.find((model) => model.id === defaultModelId)!
    const toolSupport = await runProviderSetupStage('probe', () =>
      deps.probe({ provider, model: model.id, apiKey, url: null }, getProxyFetch, boundedSignal),
    )
    boundedSignal.throwIfAborted()
    return {
      providerDefault: 1,
      provider,
      apiKey,
      supportsTools: toolSupport === 'supported',
      model: model.id,
      name: preferred.name,
      contextWindow: preferred.contextWindow,
      vendor: preferred.vendor,
      isConfidential: provider === 'tinfoil' ? 1 : 0,
      supportsParallelToolCalls: preferred.supportsParallelToolCalls,
      startWithReasoning: preferred.startWithReasoning,
    }
  }
  boundedSignal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(boundedSignal.reason)
  boundedSignal.addEventListener('abort', abort, { once: true })
  try {
    // The catalog SDK may not accept a signal; race it and ignore late results.
    return await Promise.race([work(), aborted.promise])
  } finally {
    boundedSignal.removeEventListener('abort', abort)
  }
}
