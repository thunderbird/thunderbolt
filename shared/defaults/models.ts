/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashValues } from '@shared/lib/hash'

/**
 * Shape of a shipped model default. Structurally a subset of the frontend
 * `Model` type (`src/types.ts`) — `SharedModel` intentionally omits `apiKey`,
 * which is a runtime concern (populated by the DAL from a LEFT JOIN with the
 * local-only `models_secrets` table) and must never traverse the wire. That
 * omission also makes the public `/config` endpoint structurally incapable of
 * leaking an API key even if a future server-shipped payload got sloppy.
 *
 * A compile-time assignability check in `src/types.ts` guards against silent
 * drift when the frontend `Model` gains new required fields.
 */
export type SharedModel = {
  id: string
  provider: 'openai' | 'custom' | 'openrouter' | 'thunderbolt' | 'anthropic' | 'tinfoil'
  name: string
  model: string
  url: string | null
  isSystem: number | null
  enabled: number
  toolUsage: number
  isConfidential: number
  startWithReasoning: number
  supportsParallelToolCalls: number
  contextWindow: number | null
  deletedAt: string | null
  defaultHash: string | null
  vendor: string | null
  description: string | null
  userId: string | null
}

/**
 * Compute hash of user-editable fields for a model.
 * Includes deletedAt to treat soft-delete as a user configuration choice.
 */
export const hashModel = (model: SharedModel): string => {
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
 * Default system models shipped with the application.
 * These are upserted on app start and serve as the baseline for diff comparisons.
 * Each model is exported individually so it can be referenced by automations.
 */

/**
 * Opus 4.8 reuses the row id originally assigned to Sonnet 4.5 (and inherited by 4.7).
 * Reconciliation upgrades unmodified rows in place; edited rows survive.
 */
export const defaultModelOpus48: SharedModel = {
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
  url: null,
  defaultHash: null,
  vendor: 'anthropic',
  description: 'Top-tier Anthropic reasoning',
  userId: null,
}

/**
 * Flash ships under a fresh id — not the retired V4 Pro id. Reusing Pro's id
 * would flip `isConfidential` 1 → 0 on threads that were created encrypted
 * (`isEncrypted` mirrors the model's `isConfidential` at creation), stranding
 * them because the model picker and send guard both enforce
 * `isEncrypted === isConfidential`. The retired Pro row is instead
 * soft-deleted by `cleanupRemovedDefaults`, so encrypted threads bound to it
 * surface as "model retired" rather than broken chats.
 *
 * The reconciler's `frozenFields: ['isConfidential', 'provider']` guard
 * enforces the same invariant from the OTA side — an OTA payload that ships
 * an existing id with `isConfidential` flipped is silently ignored on those
 * two columns. New values for either field must ship under a fresh id.
 */
export const defaultModelDeepseekV4Flash: SharedModel = {
  id: '019f227e-d640-727d-ba12-d51bd7d0a3d6',
  name: 'DeepSeek V4 Flash',
  provider: 'thunderbolt',
  model: 'deepseek-v4-flash',
  isSystem: 1,
  enabled: 1,
  isConfidential: 0,
  contextWindow: 131072,
  toolUsage: 1,
  startWithReasoning: 0,
  supportsParallelToolCalls: 0,
  deletedAt: null,
  url: null,
  defaultHash: null,
  vendor: 'deepseek',
  description: 'Fast DeepSeek reasoning',
  userId: null,
}

export const defaultModelGlm52: SharedModel = {
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
  url: null,
  defaultHash: null,
  vendor: 'zhipu',
  description: 'Confidential chat via Tinfoil',
  userId: null,
}

/**
 * Array of all default models for iteration. Order = display order in the
 * "Provided" group of the model picker. Reorder freely — but bump
 * `defaultModelsVersion` when you do.
 *
 * Retired between V1 and V2: `defaultModelDeepseekV4Pro` (superseded by
 * Flash under a fresh id) and `defaultModelKimiK26` (dropped). Their rows are
 * soft-deleted by `cleanupRemovedDefaults` on next reconcile; unedited copies
 * disappear cleanly, user-edited copies survive but point at retired ids and
 * will surface upstream errors when used.
 */
export const defaultModels: ReadonlyArray<SharedModel> = [
  defaultModelOpus48,
  defaultModelDeepseekV4Flash,
  defaultModelGlm52,
] as const

/**
 * Monotonic version of the shipped defaults. Bump every time `defaultModels`
 * changes in any way. The reconciler uses this as the ordering signal to
 * decide which device's defaults win in a multi-device sync group (THU-637):
 * a device only overwrites existing rows when its picked defaults version is
 * strictly newer than the highest ever applied on this account.
 *
 * The paired snapshot test in `models.test.ts` fails on any change to this
 * file's defaults without a matching version bump.
 */
export const defaultModelsVersion = 2
