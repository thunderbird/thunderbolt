/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { managedAnthropicCatalogId } from './managed-model-id'
import { http } from '@/lib/http'
import type { Model } from '@/types'
import { getSettings } from '@/dal/settings'
import { getModel } from '@/dal/models'
import { getModelProviderOptionsQuery } from '@/dal/model-profiles'
import { resolveProfileReasoningEffort } from './profile-thinking-level'
import { getDb } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import {
  noReasoningEffort,
  isReasoningEffort,
  openRouterReasoningCapabilities,
  reasoningEffortSettingKey,
  preferredReasoningEffort,
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
    if (model.provider === 'privatemode') {
      if (['glm-5.3', 'glm-5.3-flash', 'glm-latest', 'glm-flash-latest'].includes(model.model)) {
        return { efforts: ['none', 'low', 'high', 'max'] }
      }
      return model.model === 'gpt-oss-120b' ? { efforts: ['low', 'medium', 'high'] } : noReasoningEffort
    }
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

type PreferenceWriteQueue = { byModel: Map<string, Promise<void>>; tail?: Promise<void> }
const pendingWrites = new WeakMap<AnyDrizzleDatabase, PreferenceWriteQueue>()

/** Serialize preference transactions across chats; sends await only their model's latest write. */
export const queueReasoningEffortWrite = (
  db: AnyDrizzleDatabase,
  modelId: string,
  save: () => Promise<void>,
): Promise<void> => {
  const queue: PreferenceWriteQueue = pendingWrites.get(db) ?? { byModel: new Map() }
  pendingWrites.set(db, queue)
  const previous = queue.tail
  const write = (async () => {
    await Promise.allSettled([previous])
    await save()
  })()
  queue.tail = write
  queue.byModel.set(modelId, write)
  const clear = () => {
    if (queue.byModel.get(modelId) === write) {
      queue.byModel.delete(modelId)
    }
    if (queue.tail === write) {
      pendingWrites.delete(db)
    }
  }
  void write.then(clear, clear)
  return write
}

/** Read at the send boundary, so reloads and other devices use the same saved preference. */
export const getChatReasoningEffort = async (
  threadId: string,
  model: Model,
  loadCapabilities = loadReasoningCapabilities,
) => {
  const db = getDb()
  await pendingWrites.get(db)?.byModel.get(model.id)
  const legacyKey = reasoningEffortSettingKey(threadId, model.id)
  const [savedModel, settings, profile] = await Promise.all([
    getModel(db, model.id),
    getSettings(db, { [legacyKey]: String }, { camelCase: false }),
    getModelProviderOptionsQuery(db, model.id).get(),
  ])
  const saved = savedModel?.reasoningEffort ?? settings[legacyKey]
  try {
    const capabilities = await loadCapabilities(model)
    const preference = resolveReasoningEffort(saved, capabilities)
    const profileEffort = resolveProfileReasoningEffort(profile?.providerOptions, capabilities)
    // Leave configured profile options untouched unless the user chose an override.
    // This preserves native options such as an exact Anthropic thinking budget.
    if (preference !== undefined || profileEffort !== undefined) {
      return preference
    }
    return preferredReasoningEffort(undefined, capabilities)
  } catch (error) {
    if (model.provider !== 'openrouter' && model.provider !== 'tinfoil') {
      throw error
    }
    // Discovery is advisory: preserve the user's explicit choice during a cold
    // catalog outage and let the inference endpoint validate it.
    console.warn(
      `Could not discover ${model.provider} reasoning capabilities; using the saved effort if available`,
      error,
    )
    return isReasoningEffort(saved) ? saved : undefined
  }
}
