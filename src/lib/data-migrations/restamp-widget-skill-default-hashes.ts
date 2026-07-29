/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { skillsTable } from '@/db/tables'
import { hashSkill, isWidgetSkillId } from '@/defaults/skills'
import { eq, isNotNull } from 'drizzle-orm'
import type { DataMigration } from './index'

/**
 * Re-stamp widget contracts from the former full-row hash to the content-only
 * hash. Widget enabled state and any legacy pinned state must survive contract
 * updates, so every known widget row with a default hash can safely adopt the
 * new formula even when that state no longer matches its shipped default.
 * Task-skill hashes remain untouched because their state changes still
 * represent user edits.
 *
 * Idempotent: rows already stamped with the content-only hash are skipped.
 *
 * Reconciliation invokes this migration immediately before its skills pass so
 * shipped full-row hashes are recognized on the same boot as a contract
 * update. The normal post-reconcile migration runner invokes it again as an
 * idempotent no-op.
 *
 * DELETE ME: once telemetry shows the active population has upgraded past the
 * first release containing defaults v5, this migration can be removed.
 */
export const restampWidgetSkillDefaultHashes: DataMigration = {
  id: 'restamp-widget-skill-default-hashes',
  run: async (db) => {
    const rows = await db.select().from(skillsTable).where(isNotNull(skillsTable.defaultHash))
    for (const row of rows) {
      if (!isWidgetSkillId(row.id)) {
        continue
      }
      const defaultHash = hashSkill(row)
      if (row.defaultHash === defaultHash) {
        continue
      }
      await db.update(skillsTable).set({ defaultHash }).where(eq(skillsTable.id, row.id))
    }
  },
}
