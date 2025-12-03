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
  isConfidential: 1,
  contextWindow: 131072,
  toolUsage: 1,
  startWithReasoning: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
}

export const defaultModelMistralLarge3Instruct: Model = {
  id: '019ae611-26e5-7445-8fec-a326229f847f',
  name: 'mistral-large-3-instruct',
  provider: 'thunderbolt',
  model: 'mistral-large-3-fp8',
  isSystem: 0,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 250000,
  toolUsage: 1,
  startWithReasoning: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
}

/**
 * Array of all default models for iteration
 */
export const defaultModels: ReadonlyArray<Model> = [defaultModelGptOss120b, defaultModelMistralLarge3Instruct] as const
