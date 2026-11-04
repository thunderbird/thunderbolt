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

/** Resolve capabilities from the serving provider, never from the existence of a profile preference. */
const resolveCapabilities = async (model: Model): Promise<ReasoningCapabilities> => {
  if (model.provider === 'tinfoil') {
    return tinfoilReasoningCapabilities(model.model)
  }
  if (model.provider === 'openrouter') {
    const catalog = routerCatalogSchema.parse(await http.get('https://openrouter.ai/api/v1/models').json())
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

/** Read at the send boundary, so reloads and other devices use the same saved preference. */
export const getChatReasoningEffort = async (threadId: string, model: Model) => {
  const key = reasoningEffortSettingKey(threadId, model.id)
  const settings = await getSettings(getDb(), { [key]: String }, { camelCase: false })
  if (!isReasoningEffort(settings[key])) {
    return undefined
  }
  return resolveReasoningEffort(settings[key], await loadReasoningCapabilities(model))
}

const capabilityCache = new Map<string, { expires: number; value: Promise<ReasoningCapabilities> }>()

/** Share discovery between the selector and send path, without retaining credentials or retrying failed requests forever. */
export const loadReasoningCapabilities = (model: Model): Promise<ReasoningCapabilities> => {
  const key = JSON.stringify([model.provider, model.model, model.vendor])
  const existing = capabilityCache.get(key)
  if (existing && existing.expires > Date.now()) {
    return existing.value
  }
  const value = resolveCapabilities(model)
  capabilityCache.set(key, { expires: Date.now() + 300_000, value })
  void value.catch(() => {
    if (capabilityCache.get(key)?.value === value) {
      capabilityCache.delete(key)
    }
  })
  return value
}
