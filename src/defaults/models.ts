import { hashValues } from '@/lib/utils'
import type { Model } from '@/types'

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
export const defaultModelGptOss120b: Model = {
  id: 'd045a4c0-3f93-4f30-a608-24e07856e11d',
  name: 'gpt-oss',
  provider: 'thunderbolt',
  model: 'gpt-oss-120b',
  isSystem: 1,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 131072,
  toolUsage: 1,
  startWithReasoning: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
}

export const defaultModelQwen3Instruct: Model = {
  id: '0198ecc5-cc2b-735b-b478-7c6770371b84',
  name: 'qwen3-instruct',
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
  name: 'qwen3-thinking',
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
  defaultModelGptOss120b,
  defaultModelQwen3Instruct,
  defaultModelQwen3Thinking,
] as const
