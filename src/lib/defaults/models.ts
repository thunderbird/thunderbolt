import type { Model } from '@/types'
import { hashValues } from '../utils'

/**
 * Compute hash of user-editable fields for a model
 * Includes deletedAt to treat soft-delete as a user configuration choice
 */
export const hashModel = (model: Model): string => {
  return hashValues([
    model.name,
    model.provider,
    model.model,
    model.url,
    model.apiKey,
    model.isSystem,
    model.enabled,
    model.toolUsage,
    model.isConfidential,
    model.startWithReasoning,
    model.contextWindow,
    model.deletedAt,
  ])
}

/**
 * Default system models shipped with the application
 * These are upserted on app start and serve as the baseline for diff comparisons
 *
 * Each model is exported individually so it can be referenced by automations
 */
export const defaultModelQwen3Flower: Model = {
  id: '0198ecc5-cc2b-735b-b478-785b85d3c731',
  name: 'Qwen 3',
  provider: 'flower',
  model: 'qwen/qwen3-235b',
  isSystem: 1,
  enabled: 1,
  isConfidential: 1,
  contextWindow: 32000,
  toolUsage: 1,
  startWithReasoning: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
}

export const defaultModelQwen3Instruct: Model = {
  id: '0198ecc5-cc2b-735b-b478-7c6770371b84',
  name: 'Qwen 3',
  provider: 'thunderbolt',
  model: 'qwen3-235b-a22b-instruct-2507',
  isSystem: 0,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 256000,
  toolUsage: 1,
  startWithReasoning: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
}

export const defaultModelQwen3Thinking: Model = {
  id: '0198ecc5-cc2b-735b-b478-80dcfed4ea97',
  name: 'Qwen 3 (Thinking)',
  provider: 'thunderbolt',
  model: 'qwen3-235b-a22b-thinking-2507',
  isSystem: 0,
  enabled: 1,
  isConfidential: 0,
  startWithReasoning: 1,
  contextWindow: 256000,
  toolUsage: 1,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
}

/**
 * Array of all default models for iteration
 */
export const defaultModels: ReadonlyArray<Model> = [
  defaultModelQwen3Flower,
  defaultModelQwen3Instruct,
  defaultModelQwen3Thinking,
] as const
