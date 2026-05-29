/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

/**
 * Opus 4.7 keeps the row id originally assigned to Sonnet 4.5.
 * Reconciliation detects the hash change and upgrades unmodified Sonnet 4.5
 * rows in place; users who edited their Sonnet 4.5 row keep it untouched.
 */
export const defaultModelOpus47: Model = {
  id: '019af08a-c27b-7074-8aac-95315d1ef3fd',
  name: 'Opus 4.7',
  provider: 'thunderbolt',
  model: 'opus-4.7',
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
  description: 'Top-tier Anthropic reasoning',
  userId: null,
}

export const defaultModelTinfoil: Model = {
  id: '019e70af-e5b2-76d0-9ede-f22d8265bb14',
  name: 'DeepSeek R1 70B',
  provider: 'tinfoil',
  model: 'deepseek-r1-70b',
  isSystem: 1,
  enabled: 1,
  isConfidential: 1,
  contextWindow: 131072,
  toolUsage: 1,
  startWithReasoning: 0,
  supportsParallelToolCalls: 0,
  deletedAt: null,
  apiKey: null,
  url: null,
  defaultHash: null,
  vendor: 'deepseek',
  description: 'Confidential reasoning via Tinfoil',
  userId: null,
}

/**
 * Array of all default models for iteration
 */
export const defaultModels: ReadonlyArray<Model> = [
  defaultModelGptOss120b,
  defaultModelOpus47,
  defaultModelTinfoil,
] as const
