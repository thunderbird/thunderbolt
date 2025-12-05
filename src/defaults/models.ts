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
  vendor: 'openai',
  description: 'Fast and confidential',
}

export const defaultModelMistralLarge3Instruct: Model = {
  id: '019ae611-26e5-7445-8fec-a326229f847f',
  name: 'mistral-large-3',
  provider: 'thunderbolt',
  model: 'mistral-large-3',
  isSystem: 1,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 256000,
  toolUsage: 1,
  startWithReasoning: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
  vendor: 'mistral',
  description: 'Balance between privacy and power',
}

export const defaultModelMistralMedium31: Model = {
  id: '019ae612-5b8d-7a92-c4f3-9e6g8d3b2f10',
  name: 'mistral-medium-3.1',
  provider: 'thunderbolt',
  model: 'mistral-medium-3.1',
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
  vendor: 'mistral',
  description: 'Balanced performance and efficiency',
}

export const defaultModelSonnet45: Model = {
  id: '019ae612-4a7c-7f91-b3e2-8d5f7c2a1e09',
  name: 'sonnet-4.5',
  provider: 'thunderbolt',
  model: 'sonnet-4.5',
  isSystem: 1,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 200000,
  toolUsage: 1,
  startWithReasoning: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
  vendor: 'anthropic',
  description: 'Advanced reasoning and creativity',
}

/**
 * Array of all default models for iteration
 */
export const defaultModels: ReadonlyArray<Model> = [
  defaultModelGptOss120b,
  defaultModelMistralMedium31,
  defaultModelMistralLarge3Instruct,
  defaultModelSonnet45,
] as const
