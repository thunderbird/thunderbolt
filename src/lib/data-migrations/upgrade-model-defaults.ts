/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { modelsTable } from '@/db/tables'
import {
  defaultModelGlm53,
  defaultModelGlm53Flash,
  defaultModelOpus5,
  hashModel,
  type SharedModel,
} from '@shared/defaults/models'
import { eq } from 'drizzle-orm'

// Reused ids must move past legacy slugs even when user edits block normal
// reconciliation. Enumerate shipped slugs/names to preserve custom identities.
const modelLineages = [
  {
    target: defaultModelOpus5,
    legacySlugs: ['sonnet-4.5', 'opus-4.8'],
    legacyNames: ['sonnet-4.5', 'Sonnet 4.5', 'Opus 4.8'],
  },
  {
    target: defaultModelGlm53,
    legacySlugs: ['glm-5-1', 'glm-5-2'],
    legacyNames: ['GLM 5.1', 'GLM 5.2'],
  },
  {
    target: defaultModelGlm53Flash,
    legacySlugs: ['deepseek-v4-flash'],
    legacyNames: ['DeepSeek V4 Flash'],
  },
]

/** Normalize reused model identities so stale defaults cannot restore legacy slugs. */
export const normalizeModelDefault = (model: SharedModel): SharedModel => {
  const lineage = modelLineages.find(({ target }) => target.id === model.id)
  if (!lineage || !lineage.legacySlugs.includes(model.model)) {
    return model
  }

  return {
    ...model,
    model: lineage.target.model,
    name: lineage.legacyNames.includes(model.name) ? lineage.target.name : model.name,
  }
}

/** Upgrade active canonical rows while preserving user customizations. */
export const upgradeModelDefaults = async (db: AnyDrizzleDatabase): Promise<void> => {
  for (const { target, legacySlugs } of modelLineages) {
    const existing = await db.select().from(modelsTable).where(eq(modelsTable.id, target.id)).get()
    if (!existing || existing.deletedAt !== null || existing.model === null || !legacySlugs.includes(existing.model)) {
      continue
    }

    const existingModel = existing as SharedModel
    const migratedModel = normalizeModelDefault(existingModel)
    const isIntact = existing.defaultHash !== null && hashModel(existingModel) === existing.defaultHash

    await db
      .update(modelsTable)
      .set({
        model: migratedModel.model,
        name: migratedModel.name,
        defaultHash: isIntact ? hashModel(migratedModel) : existing.defaultHash,
      })
      .where(eq(modelsTable.id, target.id))
  }
}
