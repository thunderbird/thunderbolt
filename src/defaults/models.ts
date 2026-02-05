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
    model.supportsParallelToolCalls,
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
  name: 'GPT OSS',
  provider: 'thunderbolt',
  model: 'gpt-oss-120b',
  isSystem: 1,
  enabled: 1,
  isConfidential: 1,
  contextWindow: 131072,
  toolUsage: 1,
  startWithReasoning: 0,
  supportsParallelToolCalls: 1,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
  vendor: 'openai',
  description: 'Fast and confidential',
  userId: null,
}

export const defaultModelMistralMedium31: Model = {
  id: '019af08a-9836-783d-ab56-39b9fec48af1',
  name: 'Mistral Medium 3.1',
  provider: 'thunderbolt',
  model: 'mistral-medium-3.1',
  isSystem: 1,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 131072,
  toolUsage: 1,
  startWithReasoning: 0,
  supportsParallelToolCalls: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
  vendor: 'mistral',
  description: 'Balanced performance and efficiency',
  userId: null,
}

export const defaultModelSonnet45: Model = {
  id: '019af08a-c27b-7074-8aac-95315d1ef3fd',
  name: 'Sonnet 4.5',
  provider: 'thunderbolt',
  model: 'sonnet-4.5',
  isSystem: 1,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 200000,
  toolUsage: 1,
  startWithReasoning: 0,
  supportsParallelToolCalls: 1,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
  vendor: 'anthropic',
  description: 'Advanced reasoning and creativity',
  userId: null,
}

/**
 * Array of all default models for iteration
 */
export const defaultModels: ReadonlyArray<Model> = [
  defaultModelGptOss120b,
  defaultModelMistralMedium31,
  defaultModelSonnet45,
] as const
