/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { hashSkill } from '@/defaults/skills'
import { skillsTable } from '@/db/tables'
import { hashValues } from '@/lib/utils'
import { eq, isNotNull } from 'drizzle-orm'
import type { DataMigration } from './index'

/**
 * The skills `defaultHash` formula as it existed before `label` was added to
 * `hashSkill` (design-refresh / defaults v2). Frozen here on purpose — this
 * migration must recognize hashes stamped by old builds byte-for-byte, no
 * matter how `hashSkill` evolves later.
 */
const legacyHashSkill = (row: typeof skillsTable.$inferSelect): string =>
  hashValues([row.name, row.description, row.instruction, row.enabled, row.pinnedOrder, row.deletedAt])

/**
 * Re-stamp `defaultHash` values written by builds where `hashSkill` covered
 * six fields (no `label`). Without this, every pristine default-skill row on
 * an upgraded account hashes differently under the new seven-field formula,
 * reconciliation misreads it as user-edited, the skills version marker never
 * advances past 1, and every subsequent boot takes the slow blocking-sync
 * path (`hasCurrentDefaultsVersions` keeps failing).
 *
 * Only rows whose CURRENT content still hashes to the stored value under the
 * legacy formula are touched — user-edited rows (stripped or stale hash) and
 * soft-deleted rows fall through the equality check untouched. Idempotent:
 * once re-stamped, the stored hash no longer matches the legacy formula.
 *
 * Note on ordering: data migrations run after `reconcileDefaults` in app
 * init, so the v2 defaults (labels) land on the boot AFTER the re-stamp.
 *
 * DELETE ME: once telemetry shows the active population has upgraded past
 * 0.1.109, this migration can be removed in a follow-up PR.
 */
export const restampSkillDefaultHashes: DataMigration = {
  id: 'restamp-skill-default-hashes',
  run: async (db) => {
    const rows = await db.select().from(skillsTable).where(isNotNull(skillsTable.defaultHash))
    for (const row of rows) {
      if (row.defaultHash !== legacyHashSkill(row)) {
        continue
      }
      await db
        .update(skillsTable)
        .set({ defaultHash: hashSkill(row) })
        .where(eq(skillsTable.id, row.id))
    }
  },
}
