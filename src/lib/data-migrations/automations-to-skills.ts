/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deleteTriggersForPrompt, maxPinnedSkills } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { promptsTable, skillsTable } from '@/db/tables'
import { trackEvent } from '@/lib/posthog'
import { clearNullableColumns, hashValues, nowIso } from '@/lib/utils'
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
 * on `count === 0 && stranded === 0` events (see THU-560). `count` alone
 * isn't enough — a user with a slug-colliding automation reports 0
 * migrated forever, but their source row is still alive in `promptsTable`
 * and would be lost if THU-560 dropped the table on a count-only signal.
 */
export const automationsToSkills: DataMigration = {
  id: 'automations-to-skills',
  run: async (db) => {
    const result = await runOnce(db)
    // Fire-and-forget telemetry on every run, even when both counts are 0 —
    // the all-zero events are how we know the population has converged
    // before THU-560 deletes the legacy code. `stranded` covers automations
    // we couldn't migrate (slug collision or non-slugifiable title) — their
    // source rows are still alive in `promptsTable` and would be lost if
    // we dropped the table without addressing them.
    trackEvent('automations_migration_run', { count: result.migrated, stranded: result.stranded })
  },
}

type Outcome =
  /** Source automation soft-deleted; a new skill row was inserted. */
  | 'migrated'
  /** Source soft-deleted but no new skill (no-content husk, default-hash match, or already-migrated). */
  | 'skipped'
  /** Source still alive in `promptsTable`. THU-560 must not drop the table while this is > 0. */
  | 'stranded'

type RunResult = { migrated: number; stranded: number }

const runOnce = async (db: AnyDrizzleDatabase): Promise<RunResult> => {
  const automations = await db.select().from(promptsTable).where(isNull(promptsTable.deletedAt))
  if (automations.length === 0) {
    return { migrated: 0, stranded: 0 }
  }

  // Snapshot the current pin slots so we can append migrated skills without
  // colliding with existing `pinnedOrder` values. We track two things:
  //   - `nextPinnedOrder` = max(existing pinnedOrder) + 1. Starting from the
  //     count alone would collide when pins are non-contiguous (e.g. a user
  //     unpinned one in the middle leaving slots [0, 1, 5]).
  //   - `pinnedCount` = how many skills are currently pinned. The cap is
  //     defined on count, not on slot index, so this is what we compare
  //     against `maxPinnedSkills`.
  const existingPinned = await db
    .select({ pinnedOrder: skillsTable.pinnedOrder })
    .from(skillsTable)
    .where(and(isNull(skillsTable.deletedAt), isNotNull(skillsTable.pinnedOrder)))
  let nextPinnedOrder = existingPinned.reduce((m, p) => Math.max(m, p.pinnedOrder ?? -1), -1) + 1
  let pinnedCount = existingPinned.length

  // Sort so the migration is deterministic across devices: same input order
  // produces the same pin assignments. UUIDv7 sorts chronologically, so
  // "id order" = "created order" — a reasonable proxy for "which automation
  // did the user set up first."
  const sortedAutomations = [...automations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  let migrated = 0
  let stranded = 0
  for (const automation of sortedAutomations) {
    const pinSlot = pinnedCount < maxPinnedSkills ? nextPinnedOrder : null
    try {
      const outcome = await migrateOne(db, automation, pinSlot)
      if (outcome === 'migrated') {
        migrated++
        if (pinSlot !== null) {
          nextPinnedOrder++
          pinnedCount++
        }
      } else if (outcome === 'stranded') {
        stranded++
      }
    } catch (error) {
      // One bad row shouldn't block the rest. The next launch will try
      // again. Conservatively count it as stranded so the THU-560 gate
      // doesn't fire while there's still an un-handled row.
      stranded++
      console.error('Failed to migrate automation:', automation.id, error)
    }
  }
  return { migrated, stranded }
}

const migrateOne = async (
  db: AnyDrizzleDatabase,
  automation: typeof promptsTable.$inferSelect,
  pinSlot: number | null,
): Promise<Outcome> => {
  if (!automation.title && !automation.prompt) {
    // True husk — both fields empty, nothing recoverable. Soft-delete and
    // move on. (Defensive: the DAL nulls content on soft-delete, so a
    // non-null `deletedAt` would have filtered this row out upstream;
    // this branch covers a row that somehow lost its content without
    // being soft-deleted.)
    await db.transaction(async (tx) => {
      await softDeleteSourceAutomation(tx, automation.id)
    })
    return 'skipped'
  }

  if (!automation.title || !automation.prompt) {
    // One field empty, one populated — destructive paths beyond this point
    // would null the surviving field via soft-delete. Treat as stranded
    // (source stays alive, telemetry surfaces it) so we don't silently
    // discard recoverable content. THU-560's drop-the-table gate sees this
    // in the `stranded` count.
    console.warn(
      `Skipping migration: automation "${automation.id}" has incomplete content ` +
        `(title=${!!automation.title}, prompt=${!!automation.prompt}); leaving it in place.`,
    )
    return 'stranded'
  }

  // Unmodified default automation: the equivalent default skill is already
  // seeded by reconcileDefaults, so don't create a parallel migrated copy
  // — just soft-delete the source. If the user has customized the default
  // (current hash != defaultHash), fall through to the normal migration
  // path. The customized row will slug-collide with the default skill
  // (skip + log), which is an acceptable trade-off for a tiny edge case.
  if (automation.defaultHash !== null && hashAutomationRow(automation) === automation.defaultHash) {
    await db.transaction(async (tx) => {
      await softDeleteSourceAutomation(tx, automation.id)
    })
    return 'skipped'
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
    await db.transaction(async (tx) => {
      await softDeleteSourceAutomation(tx, automation.id)
    })
    return 'skipped'
  }

  const slug = slugifySkillName(automation.title)
  if (!slug) {
    // Stranded: title has no slugifiable characters at all (e.g. "!!!" or
    // pure CJK). Source stays alive — without a UI to rename it, the user
    // can't unstick it, but we surface the count in telemetry so the
    // THU-560 gate doesn't drop the table while these rows exist.
    console.warn(`Skipping migration: automation "${automation.id}" has no slugifiable title.`)
    return 'stranded'
  }

  // Slug collision: an existing skill (default seed, user-created, or
  // previously migrated under a different automation id) already owns this
  // name. Source stays alive — see the `stranded` outcome above for the
  // telemetry implications.
  const slugTaken = await db
    .select({ id: skillsTable.id })
    .from(skillsTable)
    .where(and(eq(skillsTable.name, slug), isNull(skillsTable.deletedAt)))
    .get()
  if (slugTaken) {
    console.warn(
      `Skipping migration: skill name "${slug}" already taken; leaving automation "${automation.id}" in place.`,
    )
    return 'stranded'
  }

  await db.transaction(async (tx) => {
    await tx.insert(skillsTable).values({
      id: skillId,
      name: slug,
      description: `Migrated from automation: ${automation.title}`,
      instruction: automation.prompt,
      enabled: 1,
      pinnedOrder: pinSlot,
      deletedAt: null,
      defaultHash: null,
      userId: automation.userId,
    })
    await softDeleteSourceAutomation(tx, automation.id)
  })
  return 'migrated'
}

/**
 * Soft-delete the source automation and any triggers attached to it. Scrubs all
 * nullable columns (not just title/prompt) so this stays in lock-step with the
 * DAL's `deleteAutomation` — reuse `clearNullableColumns` and `deleteTriggersForPrompt`
 * rather than hand-listing columns that could drift.
 */
const softDeleteSourceAutomation = async (db: AnyDrizzleDatabase, automationId: string): Promise<void> => {
  await deleteTriggersForPrompt(db, automationId)
  await db
    .update(promptsTable)
    .set({ ...clearNullableColumns(promptsTable), deletedAt: nowIso() })
    .where(and(eq(promptsTable.id, automationId), isNull(promptsTable.deletedAt)))
}
