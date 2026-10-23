/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Catalog data only: the composer must not import the adapter or provider runtimes.
import { ANTHROPIC_MODELS as anthropicModels } from '@earendil-works/pi-ai/providers/anthropic.models'
import type { Model } from '@/types'

const piProviders = new Set<Model['provider']>([
  'anthropic',
  'openai',
  'custom',
  'openrouter',
  'thunderbolt',
  'tinfoil',
])

/** Whether a model is eligible for Pi resolution. Tinfoil has no legacy fallback. */
export const isPiModelCandidate = (model: Pick<Model, 'provider' | 'toolUsage'>): boolean =>
  piProviders.has(model.provider) && (model.provider === 'tinfoil' || model.toolUsage !== 0)

/** Pi 0.82.1 has no Opus 5.5 entry; borrow Opus 5's metadata while keeping the wire slug. */
export const managedAnthropicCatalogId = (modelId: string): string =>
  modelId === 'opus-5-5' ? 'claude-opus-5' : `claude-${modelId}`

/** Match Pi's resolvable models without loading its engine or opening a transport. */
export const supportsPiCompaction = (
  model: Pick<Model, 'provider' | 'toolUsage' | 'model' | 'vendor' | 'apiKey' | 'url'>,
): boolean => {
  if (!isPiModelCandidate(model)) {
    return false
  }
  if (model.provider === 'anthropic') {
    return Object.hasOwn(anthropicModels, model.model)
  }
  if (model.provider === 'thunderbolt' && model.vendor === 'anthropic') {
    return Object.hasOwn(anthropicModels, managedAnthropicCatalogId(model.model))
  }
  if (model.provider === 'openai' || model.provider === 'openrouter') {
    return Boolean(model.apiKey)
  }
  if (model.provider === 'custom') {
    return Boolean(model.url && model.apiKey)
  }
  return true
}
