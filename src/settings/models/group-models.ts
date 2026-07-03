/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'

/** A group of curated models sharing a provider connection (or provider type). */
export type ModelGroup = {
  /** Stable group key: the connection id, or `type:<provider>` for system/legacy rows. */
  key: string
  /** Connection id when the models were added from a connected provider; null otherwise. */
  providerId: string | null
  /** The `modelsTable.provider` enum for the group (used for the display fallback). */
  provider: string
  models: Model[]
}

/**
 * Group curated models by their provider connection so the Models page can
 * render one section per provider (spec.md §8). Rows carrying a `providerId`
 * group by that connection; system/legacy rows (null `providerId`) group by
 * their `provider` enum. Encounter order is preserved so the caller's sort
 * (system-first, then name) still governs.
 */
export const groupModelsByProvider = (models: Model[]): ModelGroup[] => {
  const byKey = new Map<string, ModelGroup>()
  const groups: ModelGroup[] = []
  for (const model of models) {
    const key = model.providerId ?? `type:${model.provider}`
    const existing = byKey.get(key)
    if (existing) {
      existing.models.push(model)
      continue
    }
    const group: ModelGroup = { key, providerId: model.providerId ?? null, provider: model.provider, models: [model] }
    byKey.set(key, group)
    groups.push(group)
  }
  return groups
}
