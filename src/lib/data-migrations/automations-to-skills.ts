/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { maxPinnedSkills } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { promptsTable, skillsTable, triggersTable } from '@/db/tables'
import { trackEvent } from '@/lib/posthog'
import { hashValues, nowIso } from '@/lib/utils'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { DataMigration } from './index'
import { deriveSkillIdFromAutomationId } from './derive-skill-id'
import { slugifySkillName } from './slugify-skill-name'

/**
 * Hash the user-editable fields of an automation row. Mirrors the legacy
 * `defaults/automations.ts::hashPrompt`, but accepts the raw DB row shape
 * (with nullable modelId). Defined here so this migration has no import
 * from `@/defaults/automations` — that module disappears with THU-560.
 */
const hashAutomationRow = (row: typeof promptsTable.$inferSelect): string =>
  hashValues([row.title, row.prompt, row.modelId, row.deletedAt])

/**
 * Migrate each non-deleted `prompts` row into a `skills` row, then
 * soft-delete the source automation (and any triggers attached to it).
 * Once every automation has been migrated, this becomes a no-op — the
 * `WHERE deletedAt IS NULL` query against `prompts` returns empty and the
 * function exits without doing any writes.
 *
 * Slug-collision behaviour: skip + log. A user who has both a "Daily Brief"
 * automation and the seeded `daily-brief` skill keeps both; the automation
 * is left un-migrated and the user can rename one and re-launch (or just
 * delete the dead automation manually).
 *
 * Pinning behaviour: pin migrated skills in id order until the 10-pin cap
 * fills up, then leave the rest unpinned. Continuity with the legacy
 * automations UX where the user's pinned-equivalents stayed reachable.
 *
 * TODO: delete this whole file once the active-user population converges
 * on `count === 0` events (see THU-560).
 */
export const automationsToSkills: DataMigration = {
  id: 'automations-to-skills',
  run: async (db) => {
    const count = await runOnce(db)
    // Fire-and-forget telemetry on every run, even when count is 0 — the
    // zero events are how we know the population has converged before
    // THU-560 deletes the legacy code.
    trackEvent('automations_migration_run', { count })
  },
}

const runOnce = async (db: AnyDrizzleDatabase): Promise<number> => {
  const automations = await db.select().from(promptsTable).where(isNull(promptsTable.deletedAt))
  if (automations.length === 0) {
    return 0
  }

  // Snapshot the current pin-slot occupancy so we can fill the remaining
  // slots in id order. UUIDv7 sorts chronologically, so "id order" =
  // "created order" — a reasonable proxy for "which automation did the
  // user set up first."
  const existingPinned = await db
    .select({ id: skillsTable.id })
    .from(skillsTable)
    .where(and(isNull(skillsTable.deletedAt), isNotNull(skillsTable.pinnedOrder)))
  let nextPinnedOrder = existingPinned.length

  // Sort so the migration is deterministic across devices: same input order
  // produces the same pin assignments.
  const sortedAutomations = [...automations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  let migrated = 0
  for (const automation of sortedAutomations) {
    try {
      const ok = await migrateOne(db, automation, nextPinnedOrder)
      if (ok) {
        migrated++
        if (nextPinnedOrder < maxPinnedSkills) {
          nextPinnedOrder++
        }
      }
    } catch (error) {
      // One bad row shouldn't block the rest. The next launch will try
      // again.
      console.error('Failed to migrate automation:', automation.id, error)
    }
  }
  return migrated
}

const migrateOne = async (
  db: AnyDrizzleDatabase,
  automation: typeof promptsTable.$inferSelect,
  pinSlot: number,
): Promise<boolean> => {
  if (!automation.title || !automation.prompt) {
    // No content to migrate — soft-delete the husk and move on. (Defensive:
    // the DAL nulls content on soft-delete, so a non-null `deletedAt` would
    // have filtered this row out upstream; this branch covers a row that
    // somehow lost its content without being soft-deleted.)
    await db.update(promptsTable).set({ deletedAt: nowIso() }).where(eq(promptsTable.id, automation.id))
    return false
  }

  // Unmodified default automation: the equivalent default skill is already
  // seeded by reconcileDefaults, so don't create a parallel migrated copy
  // — just soft-delete the source. If the user has customized the default
  // (current hash != defaultHash), fall through to the normal migration
  // path. The customized row will slug-collide with the default skill
  // (skip + log), which is an acceptable trade-off for a tiny edge case.
  if (automation.defaultHash !== null && hashAutomationRow(automation) === automation.defaultHash) {
    await softDeleteSourceAutomation(db, automation.id)
    return false
  }

  const skillId = await deriveSkillIdFromAutomationId(automation.id)

  // Idempotency: if a skill at the derived id already exists, this
  // automation has already been migrated (either on a previous launch or
  // on another device that synced to us first). Soft-delete the source
  // and skip the insert.
  const alreadyMigrated = await db
    .select({ id: skillsTable.id })
    .from(skillsTable)
    .where(eq(skillsTable.id, skillId))
    .get()
  if (alreadyMigrated) {
    await softDeleteSourceAutomation(db, automation.id)
    return false
  }

  const slug = slugifySkillName(automation.title)
  if (!slug) {
    console.warn(`Skipping migration: automation "${automation.id}" has no slugifiable title.`)
    return false
  }

  // Slug collision: an existing skill (default seed, user-created, or
  // previously migrated under a different automation id) already owns this
  // name. Skip — user can rename either side and re-launch.
  const slugTaken = await db
    .select({ id: skillsTable.id })
    .from(skillsTable)
    .where(and(eq(skillsTable.name, slug), isNull(skillsTable.deletedAt)))
    .get()
  if (slugTaken) {
    console.warn(
      `Skipping migration: skill name "${slug}" already taken; leaving automation "${automation.id}" in place.`,
    )
    return false
  }

  await db.transaction(async (tx) => {
    await tx.insert(skillsTable).values({
      id: skillId,
      name: slug,
      description: `Migrated from automation: ${automation.title}`,
      instruction: automation.prompt,
      enabled: 1,
      pinnedOrder: pinSlot < maxPinnedSkills ? pinSlot : null,
      deletedAt: null,
      defaultHash: null,
      userId: automation.userId,
    })
    await softDeleteSourceAutomation(tx, automation.id)
  })
  return true
}

/** Soft-delete the source automation and any triggers attached to it. */
const softDeleteSourceAutomation = async (db: AnyDrizzleDatabase, automationId: string): Promise<void> => {
  const deletedAt = nowIso()
  await db.update(promptsTable).set({ title: null, prompt: null, deletedAt }).where(eq(promptsTable.id, automationId))
  await db
    .update(triggersTable)
    .set({ deletedAt })
    .where(and(eq(triggersTable.promptId, automationId), isNull(triggersTable.deletedAt)))
}
