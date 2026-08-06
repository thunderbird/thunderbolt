/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { modelsTable } from '@/db/tables'
import { defaultModelOpus5, hashModel, type SharedModel } from '@shared/defaults/models'
import { eq } from 'drizzle-orm'

const legacyModelName = 'Opus 4.8'
const legacyModelSlug = 'opus-4.8'

/**
 * Normalize the reused model identity so stale defaults payloads cannot
 * restore its legacy alias.
 */
export const normalizeOpusDefault = (model: SharedModel): SharedModel => {
  if (model.id !== defaultModelOpus5.id || model.model !== legacyModelSlug) {
    return model
  }

  return {
    ...model,
    model: defaultModelOpus5.model,
    name: model.name === legacyModelName ? defaultModelOpus5.name : model.name,
  }
}

/** Upgrade the active canonical row while preserving user customizations. */
export const upgradeOpusDefault = async (db: AnyDrizzleDatabase): Promise<void> => {
  const existing = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModelOpus5.id)).get()
  if (!existing || existing.deletedAt !== null || existing.model !== legacyModelSlug) {
    return
  }

  const existingModel = existing as SharedModel
  const migratedModel = normalizeOpusDefault(existingModel)
  const isIntact = existing.defaultHash !== null && hashModel(existingModel) === existing.defaultHash

  await db
    .update(modelsTable)
    .set({
      model: migratedModel.model,
      name: migratedModel.name,
      defaultHash: isIntact ? hashModel(migratedModel) : existing.defaultHash,
    })
    .where(eq(modelsTable.id, defaultModelOpus5.id))
}
