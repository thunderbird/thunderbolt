/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
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
  tinfoilReasoningCapabilities,
  type ReasoningCapabilities,
} from '@shared/reasoning-effort'

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

type RouterCatalog = z.infer<typeof routerCatalogSchema>
/** Create a capability resolver with one shared provider catalog cache. */
export const createReasoningCapabilitiesLoader = () => {
  const routerCatalogCache: { current?: { expires: number; value: Promise<RouterCatalog> } } = {}

  /** Share one public catalog across models; a refresh outage keeps the last known capabilities. */
  const loadRouterCatalog = (): Promise<RouterCatalog> => {
    const previous = routerCatalogCache.current
    if (previous && previous.expires > Date.now()) {
      return previous.value
    }
    const value = (async () => {
      try {
        return routerCatalogSchema.parse(
          await http.get('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10_000) }).json(),
        )
      } catch (error) {
        if (previous) {
          console.warn('Could not refresh OpenRouter reasoning capabilities; using the previous catalog', error)
          return previous.value
        }
        delete routerCatalogCache.current
        throw error
      } finally {
        if (routerCatalogCache.current) {
          routerCatalogCache.current.expires = Date.now() + 300_000
        }
      }
    })()
    // Pending requests stay shared even after a suspended tab resumes beyond the TTL.
    routerCatalogCache.current = { expires: Infinity, value }
    return value
  }

  /** Resolve capabilities from the serving provider, never from the existence of a profile preference. */
  return async (model: Model): Promise<ReasoningCapabilities> => {
    if (model.provider === 'tinfoil') {
      return tinfoilReasoningCapabilities(model.model)
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
        ? model.model === 'opus-5-5'
          ? 'claude-opus-5'
          : `claude-${model.model}`
        : model.model
    const { catalogReasoningCapabilities } = await import('@shared/agent-core/reasoning-capabilities')
    return catalogReasoningCapabilities(provider, modelId)
  }
}

export const loadReasoningCapabilities = createReasoningCapabilitiesLoader()

/** Read at the send boundary, so reloads and other devices use the same saved preference. */
export const getChatReasoningEffort = async (threadId: string, model: Model) => {
  const key = reasoningEffortSettingKey(threadId, model.id)
  const settings = await getSettings(getDb(), { [key]: String }, { camelCase: false })
  if (!isReasoningEffort(settings[key])) {
    return undefined
  }
  return resolveReasoningEffort(settings[key], await loadReasoningCapabilities(model))
}
