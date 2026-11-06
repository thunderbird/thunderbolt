/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { managedAnthropicCatalogId } from './managed-model-id'
import { http } from '@/lib/http'
import type { Model } from '@/types'
import { getSettings } from '@/dal/settings'
import { getDb } from '@/db/database'
import {
  noReasoningEffort,
  isReasoningEffort,
  openRouterReasoningCapabilities,
  reasoningEffortSettingKey,
  resolveReasoningEffort,
  type ReasoningCapabilities,
} from '@shared/reasoning-effort'
import {
  createReasoningCatalogLoader,
  parseTinfoilReasoningCatalog,
  tinfoilModelsUrl,
} from '@shared/reasoning-effort-catalog'

const routerCatalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      reasoning: z
        .object({
          supported_efforts: z.array(z.string()).nullable().optional(),
          mandatory: z.boolean().optional(),
        })
        .nullish(),
    }),
  ),
})

/** Create a capability resolver with one shared provider catalog cache. */
export const createReasoningCapabilitiesLoader = () => {
  const loadRouterCatalog = createReasoningCatalogLoader('OpenRouter', async () =>
    routerCatalogSchema.parse(
      await http.get('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10_000) }).json(),
    ),
  )
  const loadTinfoilCatalog = createReasoningCatalogLoader('Tinfoil', async () =>
    parseTinfoilReasoningCatalog(await http.get(tinfoilModelsUrl, { signal: AbortSignal.timeout(10_000) }).json()),
  )

  /** Resolve capabilities from the serving provider, never from the existence of a profile preference. */
  return async (model: Model): Promise<ReasoningCapabilities> => {
    if (model.provider === 'tinfoil') {
      return (await loadTinfoilCatalog()).get(model.model) ?? noReasoningEffort
    }
    if (model.provider === 'openrouter') {
      const catalog = await loadRouterCatalog()
      return openRouterReasoningCapabilities(catalog.data.find((row) => row.id === model.model)?.reasoning ?? undefined)
    }
    const provider = model.provider === 'thunderbolt' ? model.vendor : model.provider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return noReasoningEffort
    }
    const modelId =
      model.provider === 'thunderbolt' && provider === 'anthropic'
        ? managedAnthropicCatalogId(model.model)
        : model.model
    const { catalogReasoningCapabilities } = await import('@shared/agent-core/reasoning-capabilities')
    return catalogReasoningCapabilities(provider, modelId)
  }
}

export const loadReasoningCapabilities = createReasoningCapabilitiesLoader()

/** Read at the send boundary, so reloads and other devices use the same saved preference. */
export const getChatReasoningEffort = async (
  threadId: string,
  model: Model,
  loadCapabilities = loadReasoningCapabilities,
) => {
  const key = reasoningEffortSettingKey(threadId, model.id)
  const settings = await getSettings(getDb(), { [key]: String }, { camelCase: false })
  if (!isReasoningEffort(settings[key])) {
    return undefined
  }
  try {
    return resolveReasoningEffort(settings[key], await loadCapabilities(model))
  } catch (error) {
    if (model.provider !== 'openrouter' && model.provider !== 'tinfoil') {
      throw error
    }
    // Discovery is advisory: preserve the user's explicit choice during a cold
    // catalog outage and let the inference endpoint validate it.
    console.warn(`Could not discover ${model.provider} reasoning capabilities; keeping the saved effort`, error)
    return settings[key]
  }
}
