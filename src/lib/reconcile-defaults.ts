/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { Model, ModelProfile } from '@/types'
import { createSetting } from '@/dal'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import { modelProfilesTable, modelsTable, modesTable, settingsTable, skillsTable, tasksTable } from '../db/tables'
import { defaultModelProfiles, hashModelProfile } from '../defaults/model-profiles'
import { defaultModes, hashMode } from '../defaults/modes'
import { defaultModels, hashModel } from '../defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
import { defaultSkills, hashSkill } from '../defaults/skills'
import { defaultTasks, hashTask } from '../defaults/tasks'
import { nowIso } from './utils'

/**
 * Generic function to reconcile defaults into a table
 * Inserts new defaults and updates unmodified existing ones
 *
 * Fetches all matching rows in a single SELECT (instead of one per item) to
 * minimize serial round-trips to the SQLite worker during boot.
 * @param table - The database table to reconcile
 * @param defaults - Array of default items to reconcile
 * @param hashFn - Function to compute hash of an item
 * @param options - Per-table options: PK field name and (for workspace-scoped
 *   tables) the workspace id to tag inserts with. Settings is user-scoped and
 *   omits `workspaceId`.
 */
export const reconcileDefaultsForTable = async <T extends { defaultHash: string | null }>(
  db: AnyDrizzleDatabase,
  table: SQLiteTableWithColumns<any>,
  defaults: readonly T[],
  hashFn: (item: any) => string,
  options: { keyField?: string; workspaceId?: string } = {},
) => {
  const { keyField = 'id', workspaceId } = options
  if (defaults.length === 0) {
    return
  }

  const pkWhere = (keyValue: unknown) =>
    workspaceId
      ? and(eq(table[keyField], keyValue), eq((table as any).workspaceId, workspaceId))
      : eq(table[keyField], keyValue)

  const keyValues = defaults.map((defaultItem) => (defaultItem as any)[keyField])
  const baseWhere = workspaceId
    ? and(inArray(table[keyField], keyValues), eq((table as any).workspaceId, workspaceId))
    : inArray(table[keyField], keyValues)
  const existingRows = await db.select().from(table).where(baseWhere)
  const existingByKey = new Map(existingRows.map((row: any) => [row[keyField], row] as const))

  for (const defaultItem of defaults) {
    const keyValue = (defaultItem as any)[keyField]
    const existing = existingByKey.get(keyValue)

    if (!existing) {
      // New default - insert with computed hash
      await db.insert(table).values({
        ...defaultItem,
        ...(workspaceId ? { workspaceId } : {}),
        defaultHash: hashFn(defaultItem),
      })
      continue
    }

    // Exists - check if user modified by comparing hashes
    const currentHash = hashFn(existing)
    const defaultHashValue = hashFn(defaultItem)

    if (!existing.defaultHash) {
      // No defaultHash - set it to the default hash to enable modification tracking
      await db.update(table).set({ defaultHash: defaultHashValue }).where(pkWhere(keyValue))
      continue
    }

    // If hashes don't match, user has modified (including soft-delete) - skip update
    if (currentHash !== existing.defaultHash) {
      continue
    }

    // Skip update if default hasn't changed (prevents empty PATCH operations)
    // TODO: needs more testing
    if (existing.defaultHash === defaultHashValue) {
      continue
    }

    // Protect user-set values from being overwritten by null defaults.
    // This handles localization settings (distance_unit, etc.) where the user explicitly
    // set a value via recomputeHash, but the code default is null.
    // For non-settings tables, 'value' is undefined so this check is safely skipped.
    const wouldOverwriteUserValue = existing.value !== null && (defaultItem as any).value === null

    if (wouldOverwriteUserValue) {
      continue
    }

    // Unmodified and default has changed - safe to update to new default
    await db
      .update(table)
      .set({
        ...defaultItem,
        defaultHash: defaultHashValue,
      })
      .where(pkWhere(keyValue))
  }
}

/**
 * Soft-delete any unedited system default row whose id is no longer in the
 * current defaults arrays. The hash-match guard ensures edited rows survive.
 * Skips rows without a `defaultHash` (user-created).
 *
 * Scoped to a workspace so reconcile-on-boot for the personal workspace can't
 * sweep away defaults seeded into a different workspace under per-workspace
 * uuids (see `seedFreshWorkspaceDefaultsInTx`). Rows in other workspaces look
 * "removed" to this cleanup because their ids don't match any shipped default
 * id even though they ARE the shipped defaults under different ids.
 */
export const cleanupRemovedDefaults = async (db: AnyDrizzleDatabase, workspaceId: string) => {
  const now = nowIso()
  const currentModelIds = new Set(defaultModels.map((m) => m.id))

  // One workspace-scoped SELECT serves both loops: the system-model scan below
  // and the alive-model set used by the profile loop. Models soft-deleted in
  // the scan are removed from the set in memory, matching the previous behavior
  // of querying alive ids after the deletes.
  const aliveModels = (await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.workspaceId, workspaceId), isNull(modelsTable.deletedAt)))) as Model[]
  const aliveModelIds = new Set(aliveModels.map((m) => m.id))

  for (const row of aliveModels) {
    if (row.isSystem !== 1 || currentModelIds.has(row.id) || !row.defaultHash) {
      continue
    }
    if (hashModel(row) === row.defaultHash) {
      await db
        .update(modelsTable)
        .set({ deletedAt: now })
        .where(and(eq(modelsTable.id, row.id), eq(modelsTable.workspaceId, workspaceId)))
      aliveModelIds.delete(row.id)
    }
  }

  // Profiles are 1:1 with models. Mirror the model loop's "edited rows survive"
  // rule by following the parent model's fate — only delete the profile when
  // its parent is no longer alive. Otherwise a user who renamed a retired
  // default model but left the profile at shipped defaults would be left with
  // an orphaned model.
  const profiles = (await db
    .select()
    .from(modelProfilesTable)
    .where(
      and(eq(modelProfilesTable.workspaceId, workspaceId), isNull(modelProfilesTable.deletedAt)),
    )) as ModelProfile[]
  for (const row of profiles) {
    if (aliveModelIds.has(row.modelId) || !row.defaultHash) {
      continue
    }
    if (hashModelProfile(row) === row.defaultHash) {
      await db
        .update(modelProfilesTable)
        .set({ deletedAt: now })
        .where(and(eq(modelProfilesTable.modelId, row.modelId), eq(modelProfilesTable.workspaceId, workspaceId)))
    }
  }
}

/**
 * Reconciles default rows for all default-aware tables. The workspace-scoped
 * defaults (models / modes / tasks / skills / model_profiles) are tagged with
 * `workspaceId` — typically the caller's personal workspace, resolved by the
 * boot path once sync has brought it down. Settings is user-scoped and does
 * not take a workspace.
 *
 * For seeding a freshly-created additional workspace (e.g. shared workspaces
 * from the Create Workspace modal) use `seedFreshWorkspaceDefaultsInTx`
 * instead — it generates per-workspace ids to avoid collisions with the
 * personal workspace's default rows (the FE schema's `id` PK is single-column).
 */
export const reconcileDefaults = async (db: AnyDrizzleDatabase, workspaceId: string) => {
  await db.transaction(async (tx) => {
    // Soft-delete removed system defaults before reconciling current ones.
    await cleanupRemovedDefaults(tx, workspaceId)

    // AI models
    await reconcileDefaultsForTable(tx, modelsTable, defaultModels, hashModel, { workspaceId })

    // Model profiles (after models, because they reference model IDs)
    await reconcileDefaultsForTable(tx, modelProfilesTable, defaultModelProfiles, hashModelProfile, {
      keyField: 'modelId',
      workspaceId,
    })

    // Modes
    await reconcileDefaultsForTable(tx, modesTable, defaultModes, hashMode, { workspaceId })

    // Tasks
    await reconcileDefaultsForTable(tx, tasksTable, defaultTasks, hashTask, { workspaceId })

    // Skills (the default skills supersede the legacy default automations,
    // which used to seed promptsTable here. See THU-547.)
    await reconcileDefaultsForTable(tx, skillsTable, defaultSkills, hashSkill, { workspaceId })

    // Settings — user-scoped (not workspace-scoped).
    await reconcileDefaultsForTable(tx, settingsTable, defaultSettings, hashSetting, { keyField: 'key' })

    // Initialize anonymous ID for analytics (unique per user)
    await createSetting(tx, 'anonymous_id', uuidv7())
  })
}

/**
 * Seeds the five workspace-scoped default tables (models / model_profiles /
 * modes / tasks / skills) into a freshly-created workspace, generating new
 * per-workspace ids for every row.
 *
 * Why fresh ids: the FE schema uses a single-column `id` primary key on each
 * synced table (see docs/architecture/composite-primary-keys-and-default-data.md).
 * Default rows carry hardcoded ids (e.g. `mode-chat`, fixed UUIDs in
 * `defaults/models`). Reusing those ids across a user's personal workspace and
 * a new shared workspace produces a SQLite PK collision on the second insert.
 * Random ids per workspace sidestep that without a schema/migration change.
 *
 * Differs from `reconcileDefaults` (the boot-time idempotent path) — this
 * function does not run the SELECT-then-INSERT reconcile dance because a
 * freshly-created workspace can't have prior rows.
 *
 * Operates on the caller's transaction so workspace + memberships + defaults
 * commit atomically.
 */
export const seedFreshWorkspaceDefaultsInTx = async (tx: AnyDrizzleDatabase, workspaceId: string) => {
  // Remap each default model id → a per-workspace uuid so model_profiles can
  // be reconnected to the right row.
  const modelIdRemap = new Map<string, string>()

  for (const model of defaultModels) {
    const newId = uuidv7()
    modelIdRemap.set(model.id, newId)
    await tx.insert(modelsTable).values({
      ...model,
      id: newId,
      workspaceId,
      defaultHash: hashModel(model as Model),
    })
  }

  for (const profile of defaultModelProfiles) {
    const remappedModelId = modelIdRemap.get(profile.modelId)
    if (!remappedModelId) {
      // Profile references a model not in `defaultModels` — shouldn't happen
      // (the two arrays are co-authored) but skip rather than insert a dangling
      // profile.
      continue
    }
    // `model_profiles` PK is `modelId` (SQL column `id`) — there's no
    // separate id field, so remapping the modelId is enough.
    await tx.insert(modelProfilesTable).values({
      ...profile,
      modelId: remappedModelId,
      workspaceId,
      defaultHash: hashModelProfile(profile as ModelProfile),
    })
  }

  for (const mode of defaultModes) {
    await tx.insert(modesTable).values({
      ...mode,
      id: uuidv7(),
      workspaceId,
      defaultHash: hashMode(mode as Parameters<typeof hashMode>[0]),
    })
  }

  for (const task of defaultTasks) {
    await tx.insert(tasksTable).values({
      ...task,
      id: uuidv7(),
      workspaceId,
      defaultHash: hashTask(task as Parameters<typeof hashTask>[0]),
    })
  }

  for (const skill of defaultSkills) {
    await tx.insert(skillsTable).values({
      ...skill,
      id: uuidv7(),
      workspaceId,
      defaultHash: hashSkill(skill as Parameters<typeof hashSkill>[0]),
    })
  }
}
