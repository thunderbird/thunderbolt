/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { Model, ModelProfile } from '@/types'
import { createSetting } from '@/dal'
import { eq, inArray, isNull } from 'drizzle-orm'
import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core'
import { v7 as uuidv7 } from 'uuid'
import { modelProfilesTable, modelsTable, modesTable, settingsTable, skillsTable, tasksTable } from '../db/tables'
import { defaultModelProfiles, hashModelProfile } from '../defaults/model-profiles'
import { defaultModes, hashMode } from '../defaults/modes'
import { defaultModels, defaultModelsVersion, hashModel, type SharedModel } from '@shared/defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'
import { defaultSkills, hashSkill } from '../defaults/skills'
import { defaultTasks, hashTask } from '../defaults/tasks'
import type { ModelsDefaults } from './pick-defaults'
import { nowIso } from './utils'

const bundledModelsDefaults: ModelsDefaults = { version: defaultModelsVersion, data: defaultModels }

/**
 * Settings key holding the highest defaults version ever applied to this
 * account's models table. See "Reconciled defaults and version bumps" in
 * AGENTS.md and the THU-637 rationale for the version-gate design.
 */
const modelsVersionKey = 'defaults_version.models'

/**
 * Read a previously-recorded defaults version from `settingsTable`. Returns
 * `exists` separately from `version` so callers can tell "row absent" from
 * "row present with garbage value" — the two need to branch to insert vs.
 * update on write-back. `version` is null when the row is absent OR its value
 * is not a finite number (treat as "safe to apply" for the gate comparison).
 */
const readAppliedVersion = async (
  db: AnyDrizzleDatabase,
  key: string,
): Promise<{ exists: boolean; version: number | null }> => {
  const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, key))
  const row = rows[0]
  if (!row) {
    return { exists: false, version: null }
  }
  if (row.value == null) {
    return { exists: true, version: null }
  }
  const parsed = Number(row.value)
  return { exists: true, version: Number.isFinite(parsed) ? parsed : null }
}

/**
 * Generic function to reconcile defaults into a table
 * Inserts new defaults and updates unmodified existing ones
 *
 * Fetches all matching rows in a single SELECT (instead of one per item) to
 * minimize serial round-trips to the SQLite worker during boot.
 * @param table - The database table to reconcile
 * @param defaults - Array of default items to reconcile
 * @param hashFn - Function to compute hash of an item
 * @param keyField - Name of the primary key field (defaults to 'id')
 * @param canOverwrite - When false, this pass is purely non-mutating for the
 *   table: no inserts of missing rows, no bootstrap of legacy null defaultHash,
 *   no updates. Set to false when the caller's defaults source is not
 *   authoritative — either strictly older than what has already been applied
 *   on this account, or when the account's true state hasn't finished syncing
 *   yet. Prevents ghost-inserting rows that a newer version deliberately
 *   removed but hasn't finished syncing to us (see THU-637 / AGENTS.md).
 */
export const reconcileDefaultsForTable = async <T extends { defaultHash: string | null }>(
  db: AnyDrizzleDatabase,
  table: SQLiteTableWithColumns<any>,
  defaults: readonly T[],
  hashFn: (item: any) => string,
  keyField: string = 'id',
  canOverwrite: boolean = true,
) => {
  if (defaults.length === 0) {
    return
  }

  const keyValues = defaults.map((defaultItem) => (defaultItem as any)[keyField])
  const existingRows = await db.select().from(table).where(inArray(table[keyField], keyValues))
  const existingByKey = new Map(existingRows.map((row) => [row[keyField], row] as const))

  for (const defaultItem of defaults) {
    const keyValue = (defaultItem as any)[keyField]
    const existing = existingByKey.get(keyValue)

    if (!existing) {
      // Row missing locally: only seed when authoritative. Otherwise a newer
      // version's deliberate removal (still en route to us via sync) would be
      // undone by us re-inserting the bundle's copy.
      if (!canOverwrite) {
        continue
      }
      await db.insert(table).values({
        ...defaultItem,
        defaultHash: hashFn(defaultItem),
      })
      continue
    }

    // Any write against an existing row also requires authority.
    if (!canOverwrite) {
      continue
    }

    // Exists - check if user modified by comparing hashes
    const currentHash = hashFn(existing)
    const defaultHashValue = hashFn(defaultItem)

    if (!existing.defaultHash) {
      // No defaultHash - set it to the default hash to enable modification tracking
      await db.update(table).set({ defaultHash: defaultHashValue }).where(eq(table[keyField], keyValue))
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
      .where(eq(table[keyField], keyValue))
  }
}

/**
 * Soft-delete any unedited system default row whose id is no longer in the
 * current defaults arrays. The hash-match guard ensures edited rows survive.
 * Skips rows without a `defaultHash` (user-created).
 *
 * When `canOverwriteModels` is false, the models scan is skipped: our defaults
 * are older than what another device already applied, so we don't know which
 * "unrecognized" rows are legitimate additions vs. genuinely-removed defaults.
 * The profiles scan still runs but is a natural no-op in this case — no models
 * were soft-deleted, so every profile's parent stays alive.
 */
export const cleanupRemovedDefaults = async (
  db: AnyDrizzleDatabase,
  canOverwriteModels: boolean = true,
  models: readonly SharedModel[] = defaultModels,
) => {
  const now = nowIso()
  const currentModelIds = new Set(models.map((m) => m.id))

  // One SELECT serves both loops: the system-model scan below and the
  // alive-model set used by the profile loop. Models soft-deleted in the scan
  // are removed from the set in memory, matching the previous behavior of
  // querying alive ids after the deletes.
  const aliveModels = (await db.select().from(modelsTable).where(isNull(modelsTable.deletedAt))) as Model[]
  const aliveModelIds = new Set(aliveModels.map((m) => m.id))

  if (canOverwriteModels) {
    for (const row of aliveModels) {
      if (row.isSystem !== 1 || currentModelIds.has(row.id) || !row.defaultHash) {
        continue
      }
      if (hashModel(row) === row.defaultHash) {
        await db.update(modelsTable).set({ deletedAt: now }).where(eq(modelsTable.id, row.id))
        aliveModelIds.delete(row.id)
      }
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
    .where(isNull(modelProfilesTable.deletedAt))) as ModelProfile[]
  for (const row of profiles) {
    if (aliveModelIds.has(row.modelId) || !row.defaultHash) {
      continue
    }
    if (hashModelProfile(row) === row.defaultHash) {
      await db.update(modelProfilesTable).set({ deletedAt: now }).where(eq(modelProfilesTable.modelId, row.modelId))
    }
  }
}

export type ReconcileDefaultsOverrides = {
  /** Models defaults source (server OTA payload or bundled). Falls back to
   *  the shipped `defaultModels` + `defaultModelsVersion` when omitted. */
  models?: ModelsDefaults
  /** Did PowerSync's initial-sync gate finish this boot? When false (timed out
   *  or failed) we can't trust that a missing local stored version means "never
   *  applied" — cloud may hold both the version marker and newer rows we
   *  haven't received yet. Defaults to true (tests / offline first-run). */
  initialSyncCompleted?: boolean
}

export const reconcileDefaults = async (db: AnyDrizzleDatabase, overrides?: ReconcileDefaultsOverrides) => {
  const modelsSource = overrides?.models ?? bundledModelsDefaults
  const initialSyncCompleted = overrides?.initialSyncCompleted ?? true

  await db.transaction(async (tx) => {
    // Version gate for models: only overwrite rows when our defaults source
    // is strictly newer than the highest version ever applied on this account.
    // Prevents older-bundle devices from downgrading newer synced rows (THU-637).
    const stored = await readAppliedVersion(tx, modelsVersionKey)
    const rawCanOverwrite = modelsSource.version > (stored.version ?? Number.NEGATIVE_INFINITY)

    // Additional guard for the fresh-second-device / sync-timeout case: when
    // the initial sync didn't complete AND we have no local stored version,
    // cloud may hold both the version marker AND newer rows we haven't
    // received. Acting on partial state would let us regress the marker or
    // ghost-insert defaults the newer version has retired. Fresh installs
    // (0 rows) still seed the bundle so the app isn't crippled offline.
    const hasAnyModelRow = (await tx.select({ id: modelsTable.id }).from(modelsTable).limit(1)).length > 0
    const canOverwriteModels = ((): boolean => {
      if (!hasAnyModelRow) {
        return rawCanOverwrite
      }
      if (initialSyncCompleted) {
        return rawCanOverwrite
      }
      if (!stored.exists) {
        return false
      }
      return rawCanOverwrite
    })()

    // Soft-delete removed system defaults before reconciling current ones.
    await cleanupRemovedDefaults(tx, canOverwriteModels, modelsSource.data)

    // AI models
    await reconcileDefaultsForTable(tx, modelsTable, modelsSource.data, hashModel, 'id', canOverwriteModels)

    // Model profiles ship 1:1 with models and mutate together in practice, so
    // they ride the same gate — otherwise an older-bundle device would revert
    // profile settings (temperature, tools, addenda) that a newer bundle just
    // shipped alongside its model changes, reintroducing THU-637 on the profile
    // side. Insert-of-missing still runs regardless, so orphaned profiles are
    // impossible even when overwrites are skipped.
    await reconcileDefaultsForTable(
      tx,
      modelProfilesTable,
      defaultModelProfiles,
      hashModelProfile,
      'modelId',
      canOverwriteModels,
    )

    // Modes
    await reconcileDefaultsForTable(tx, modesTable, defaultModes, hashMode)

    // Tasks
    await reconcileDefaultsForTable(tx, tasksTable, defaultTasks, hashTask)

    // Skills (the default skills supersede the legacy default automations,
    // which used to seed promptsTable here. See THU-547.)
    await reconcileDefaultsForTable(tx, skillsTable, defaultSkills, hashSkill)

    // Settings
    await reconcileDefaultsForTable(tx, settingsTable, defaultSettings, hashSetting, 'key')

    if (canOverwriteModels) {
      // Inline upsert: `updateSettings` wraps its writes in its own transaction
      // and PowerSync's drizzle driver forbids nested transactions. Branch on
      // row existence — not on parsed version — so a pre-existing row with a
      // non-numeric value (data corruption, older schema) still routes to
      // UPDATE instead of hitting a primary-key conflict on INSERT.
      const versionValue = String(modelsSource.version)
      if (!stored.exists) {
        await tx.insert(settingsTable).values({ key: modelsVersionKey, value: versionValue })
      } else {
        await tx.update(settingsTable).set({ value: versionValue }).where(eq(settingsTable.key, modelsVersionKey))
      }
    }

    // Initialize anonymous ID for analytics (unique per user)
    await createSetting(tx, 'anonymous_id', uuidv7())
  })
}
