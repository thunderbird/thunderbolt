/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { modelsTable } from '@/db/tables'
import { defaultModelOpus5, hashModel, type SharedModel } from '@shared/defaults/models'
import { eq } from 'drizzle-orm'

/**
 * Slugs this row carried before `opus-5`.
 *
 * The id is reused across renames — `sonnet-4.5` → `opus-4.8` → `opus-5` — so a
 * device that missed one still serves a dead upstream slug under the id the
 * picker expects to be Opus. That is a single fault presenting as two symptoms:
 * Opus looks missing *because* the row is still the old model (THU-843).
 *
 * Reconciliation is what normally carries a rename, but it only rewrites rows
 * whose `defaultHash` still matches, so any user edit freezes the row for good.
 * This runs outside that check and is the only way those rows move forward.
 *
 * Enumerated rather than "any slug that isn't opus-5": the row is user-editable,
 * and someone who deliberately repointed it at their own model should not have
 * that silently overwritten. A future rename adds an entry here — or, better,
 * ships under a fresh id.
 */
const legacySlugs: ReadonlySet<string> = new Set(['sonnet-4.5', 'opus-4.8'])

/**
 * Names shipped alongside those slugs, including the bare slug-as-name the row
 * originally carried. Anything outside this set is the user's own label and is
 * preserved.
 */
const legacyNames: ReadonlySet<string> = new Set(['sonnet-4.5', 'Sonnet 4.5', 'Opus 4.8'])

/**
 * Normalize the reused model identity so stale defaults payloads cannot
 * restore a legacy alias.
 */
export const normalizeOpusDefault = (model: SharedModel): SharedModel => {
  if (model.id !== defaultModelOpus5.id || !legacySlugs.has(model.model)) {
    return model
  }

  return {
    ...model,
    model: defaultModelOpus5.model,
    name: legacyNames.has(model.name) ? defaultModelOpus5.name : model.name,
  }
}

/** Upgrade the active canonical row while preserving user customizations. */
export const upgradeOpusDefault = async (db: AnyDrizzleDatabase): Promise<void> => {
  const existing = await db.select().from(modelsTable).where(eq(modelsTable.id, defaultModelOpus5.id)).get()
  // A null slug is left alone, as it was under the previous equality check.
  if (!existing || existing.deletedAt !== null || existing.model === null || !legacySlugs.has(existing.model)) {
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
