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

/**
 * Opus 4.8 reuses the row id originally assigned to Sonnet 4.5 (and inherited by 4.7).
 * Reconciliation upgrades unmodified rows in place; edited rows survive.
 */
export const defaultModelOpus48: Model = {
  id: '019af08a-c27b-7074-8aac-95315d1ef3fd',
  name: 'Opus 4.8',
  provider: 'thunderbolt',
  model: 'opus-4.8',
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

export const defaultModelDeepseekV4Pro: Model = {
  id: '019e70af-e5b2-76d0-9ede-f22d8265bb14',
  name: 'DeepSeek V4 Pro',
  provider: 'tinfoil',
  model: 'deepseek-v4-pro',
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

export const defaultModelKimiK26: Model = {
  id: '019e7580-2b0c-77d6-8b99-16a99abe4591',
  name: 'Kimi K2.6',
  provider: 'tinfoil',
  model: 'kimi-k2-6',
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
  vendor: 'moonshot',
  description: 'Confidential chat via Tinfoil',
  userId: null,
}

export const defaultModelGlm52: Model = {
  id: '019e7580-2b0e-719c-a43f-d2b56e7f31b4',
  name: 'GLM 5.2',
  provider: 'tinfoil',
  model: 'glm-5-2',
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
  vendor: 'zhipu',
  description: 'Confidential chat via Tinfoil',
  userId: null,
}

/**
 * Array of all default models for iteration. Order = display order in the
 * "Provided" group of the model picker. Reorder freely.
 */
export const defaultModels: ReadonlyArray<Model> = [
  defaultModelOpus48,
  defaultModelDeepseekV4Pro,
  defaultModelKimiK26,
  defaultModelGlm52,
] as const
