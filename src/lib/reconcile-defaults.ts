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
import { defaultModes, defaultModesVersion, hashMode } from '../defaults/modes'
import { defaultModels, defaultModelsVersion, hashModel, type SharedModel } from '@shared/defaults/models'
import { defaultSettings, defaultSettingsVersion, hashSetting } from '../defaults/settings'
import { defaultSkills, defaultSkillsVersion, hashSkill } from '../defaults/skills'
import { defaultTasks, defaultTasksVersion, hashTask } from '../defaults/tasks'
import type { ModelsDefaults } from './pick-defaults'
import { nowIso } from './utils'

const bundledModelsDefaults: ModelsDefaults = { version: defaultModelsVersion, data: defaultModels }

/**
 * Settings keys holding the highest defaults version ever applied to this
 * account per reconciled table. See "Reconciled defaults and version bumps"
 * in AGENTS.md and the THU-637 rationale for the version-gate design; THU-677
 * extended the pattern from models-only to every reconciled table.
 *
 * Exported so read-side callers (`hasCurrentBundleVersions` in
 * `src/dal/settings.ts`) share the exact same key strings — a rename here
 * shouldn't require touching two files.
 */
export const versionMarkerKeys = {
  models: 'defaults_version.models',
  modes: 'defaults_version.modes',
  tasks: 'defaults_version.tasks',
  skills: 'defaults_version.skills',
  settings: 'defaults_version.settings',
} as const

type StoredVersion = { exists: boolean; version: number | null }

/**
 * Read a previously-recorded defaults version from `settingsTable`. Returns
 * `exists` separately from `version` so callers can tell "row absent" from
 * "row present with garbage value" — the two need to branch to insert vs.
 * update on write-back. `version` is null when the row is absent OR its value
 * is not a finite number (treat as "safe to apply" for the gate comparison).
 */
const readAppliedVersion = async (db: AnyDrizzleDatabase, key: string): Promise<StoredVersion> => {
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
 * Compute the version-gate + sync-incomplete guard for one reconciled table
 * and return the stored-marker snapshot alongside, so the caller can branch
 * on `stored.exists` for INSERT vs UPDATE on write-back without a second read.
 *
 * The gate collapses two safety concerns into one boolean:
 *   1. Version ordering — reject writes when our defaults source is not
 *      strictly newer than what has already been applied on this account
 *      (prevents older-bundle devices from downgrading newer synced rows).
 *   2. Sync-incomplete pessimism — when the local table already has rows and
 *      first-sync has not finished, we cannot trust that a missing marker
 *      means "never applied": cloud may hold both the marker and newer rows
 *      we haven't received yet. Fresh installs (0 rows) bypass this so the
 *      app still seeds bundle defaults offline.
 */
const computeCanOverwrite = async (
  tx: AnyDrizzleDatabase,
  versionKey: string,
  pickedVersion: number,
  hasAnyRow: boolean,
  initialSyncCompleted: boolean,
): Promise<{ canOverwrite: boolean; stored: StoredVersion }> => {
  const stored = await readAppliedVersion(tx, versionKey)
  const rawCanOverwrite = pickedVersion > (stored.version ?? Number.NEGATIVE_INFINITY)
  // Fresh install (0 rows) always seeds; a populated table needs sync to have
  // settled before we trust the stored marker enough to write.
  const canOverwrite = rawCanOverwrite && (!hasAnyRow || initialSyncCompleted)
  return { canOverwrite, stored }
}

/**
 * Upsert a defaults version marker. Branches on `stored.exists` (not on the
 * parsed version) so a pre-existing row with a non-numeric value — data
 * corruption or an older schema — still routes to UPDATE instead of hitting a
 * primary-key conflict on INSERT. Inline SQL rather than `updateSettings`
 * because PowerSync's drizzle driver forbids nested transactions.
 */
const advanceVersionMarker = async (
  tx: AnyDrizzleDatabase,
  versionKey: string,
  version: number,
  stored: StoredVersion,
) => {
  const versionValue = String(version)
  if (!stored.exists) {
    await tx.insert(settingsTable).values({ key: versionKey, value: versionValue })
  } else {
    await tx.update(settingsTable).set({ value: versionValue }).where(eq(settingsTable.key, versionKey))
  }
}

/**
 * Options for `reconcileDefaultsForTable`.
 *
 * @property keyField - Name of the primary key field. Defaults to `'id'`.
 * @property canOverwrite - When false, this pass will not update existing rows
 *   and will not bootstrap the legacy null-defaultHash column. Set to false
 *   when the caller's defaults source is not authoritative — either strictly
 *   older than what has already been applied on this account, or when the
 *   account's true state hasn't finished syncing yet.
 * @property insertMissing - When true, insert missing rows even if
 *   `canOverwrite` is false. Set for tables where a row's presence is a hard
 *   invariant regardless of authority (e.g. model profiles are 1:1 with their
 *   parent model — a model without its profile is a runtime hazard, whereas a
 *   briefly-stale profile self-heals on sync). Defaults to `canOverwrite` so
 *   tables like models keep ghost-insert protection (see THU-637 / AGENTS.md).
 * @property canResurrect - When true, undo a cleanup-shaped soft-delete of a
 *   still-shipped default. Gated separately from `canOverwrite` because the
 *   two conditions decide different things: `canOverwrite` is "authoritative
 *   to write our bundle's content", `canResurrect` is "trustworthy view of
 *   cloud state". A device with an older bundle but fully-synced state can
 *   safely undo a pre-THU-637 client's mistaken cleanup — while a device
 *   mid-sync must not, because its local "soft-deleted" flag may just be
 *   partial delivery of an authoritative retirement. Defaults to
 *   `canOverwrite` for callers that don't split the two signals.
 * @property frozenFields - Field names that must never change on an existing
 *   row via reconcile. When updating, the existing row's value is kept for
 *   each listed field and the stored `defaultHash` reflects that
 *   post-freeze state. Protects identity-critical columns whose values
 *   establish downstream contracts — e.g. `isConfidential` on models
 *   (encrypted threads bind to it at creation) and `provider` (routing).
 *   A server-shipped OTA payload cannot flip these on a bundle-known id;
 *   a new value ships under a fresh id. Only applies to updates — inserts
 *   use the default as-is.
 */
export type ReconcileDefaultsForTableOptions = {
  keyField?: string
  canOverwrite?: boolean
  insertMissing?: boolean
  canResurrect?: boolean
  frozenFields?: readonly string[]
}

/**
 * Result of a `reconcileDefaultsForTable` pass.
 *
 * @property mutated - True iff at least one row was inserted or updated (this
 *   includes the legacy null-defaultHash bootstrap). Callers use this to
 *   decide whether to advance an external version marker — advancing when
 *   nothing was actually written would falsely signal to peers that the
 *   picked version has been applied here.
 */
export type ReconcileDefaultsForTableResult = { mutated: boolean }

/**
 * Generic function to reconcile defaults into a table
 * Inserts new defaults and updates unmodified existing ones.
 *
 * Fetches all matching rows in a single SELECT (instead of one per item) to
 * minimize serial round-trips to the SQLite worker during boot.
 */
export const reconcileDefaultsForTable = async <T extends { defaultHash: string | null }>(
  db: AnyDrizzleDatabase,
  table: SQLiteTableWithColumns<any>,
  defaults: readonly T[],
  hashFn: (item: any) => string,
  options: ReconcileDefaultsForTableOptions = {},
): Promise<ReconcileDefaultsForTableResult> => {
  const {
    keyField = 'id',
    canOverwrite = true,
    insertMissing = canOverwrite,
    canResurrect = canOverwrite,
    frozenFields = [],
  } = options

  if (defaults.length === 0) {
    return { mutated: false }
  }

  const keyValues = defaults.map((defaultItem) => (defaultItem as any)[keyField])
  const existingRows = await db.select().from(table).where(inArray(table[keyField], keyValues))
  const existingByKey = new Map(existingRows.map((row) => [row[keyField], row] as const))

  let mutated = false

  for (const defaultItem of defaults) {
    const keyValue = (defaultItem as any)[keyField]
    const existing = existingByKey.get(keyValue)

    if (!existing) {
      // Row missing locally: only seed when we're allowed to. For most tables
      // that mirrors `canOverwrite` (ghost-insert protection). Tables that opt
      // into `insertMissing: true` seed regardless because their row must
      // exist for correctness (e.g. profiles paired with models).
      if (!insertMissing) {
        continue
      }
      await db.insert(table).values({
        ...defaultItem,
        defaultHash: hashFn(defaultItem),
      })
      mutated = true
      continue
    }

    // Resurrect a row soft-deleted by an older-build (pre-THU-637) client's
    // unconditional `cleanupRemovedDefaults`. Two properties make this safe:
    //   1. Cleanup only mutates `deletedAt` — content and `defaultHash` are
    //      preserved. User-driven `deleteModel` scrubs every nullable column
    //      via `clearNullableColumns`, including `defaultHash`, so a
    //      user-initiated soft-delete cannot satisfy the hash check below.
    //   2. `hashFn({...existing, deletedAt: null}) === existing.defaultHash`
    //      confirms the row's content still matches the exact default that
    //      the previous reconciler stamped — this can only be a cleanup
    //      soft-delete of a still-shipped default that just needs undoing.
    // Gated by `canResurrect` (not `canOverwrite`): a device with an older
    // bundle but fully-synced state can still safely un-delete a mistaken
    // cleanup, but a device mid-sync must not act on a possibly-partial
    // view of "soft-deleted". Regardless of the write decision, we `continue`
    // past this row — a cleanup-shaped row shouldn't fall through to the
    // user-edit branch (its `deletedAt` would trip that as a false positive).
    if (
      (existing as { deletedAt?: string | null }).deletedAt &&
      existing.defaultHash &&
      hashFn({ ...existing, deletedAt: null }) === existing.defaultHash
    ) {
      if (canResurrect) {
        await db.update(table).set({ deletedAt: null }).where(eq(table[keyField], keyValue))
        mutated = true
      }
      continue
    }

    // Any write against an existing row requires authority.
    if (!canOverwrite) {
      continue
    }

    // Exists - check if user modified by comparing hashes
    const currentHash = hashFn(existing)

    if (!existing.defaultHash) {
      // No defaultHash - set it to the default hash to enable modification tracking
      const defaultHashValue = hashFn(defaultItem)
      await db.update(table).set({ defaultHash: defaultHashValue }).where(eq(table[keyField], keyValue))
      mutated = true
      continue
    }

    // If hashes don't match, user has modified (including soft-delete) - skip update
    if (currentHash !== existing.defaultHash) {
      continue
    }

    // Compute the effective default: for each `frozenFields` entry, keep the
    // existing row's value instead of the incoming default. Hash covers the
    // effective (post-freeze) state so future reconciles still recognize the
    // row as unedited. Skips the copy entirely when no fields are frozen.
    const effectiveDefault =
      frozenFields.length === 0
        ? defaultItem
        : (frozenFields.reduce<T>((acc, field) => ({ ...acc, [field]: (existing as any)[field] }), defaultItem) as T)
    const effectiveHash = frozenFields.length === 0 ? hashFn(defaultItem) : hashFn(effectiveDefault)

    // Skip update if the effective default matches what's already stored
    // (prevents empty PATCH operations, and collapses OTA payloads that only
    // touch frozen fields to a no-op).
    if (existing.defaultHash === effectiveHash) {
      continue
    }

    // Protect user-set values from being overwritten by null defaults.
    // This handles localization settings (distance_unit, etc.) where the user explicitly
    // set a value via recomputeHash, but the code default is null.
    // For non-settings tables, 'value' is undefined so this check is safely skipped.
    const wouldOverwriteUserValue = existing.value !== null && (effectiveDefault as any).value === null

    if (wouldOverwriteUserValue) {
      continue
    }

    // Unmodified and default has changed - safe to update to new default
    await db
      .update(table)
      .set({
        ...effectiveDefault,
        defaultHash: effectiveHash,
      })
      .where(eq(table[keyField], keyValue))
    mutated = true
  }

  return { mutated }
}

/**
 * Soft-delete any system default row whose id is no longer in the current
 * defaults arrays. User-created rows are left alone (guarded by
 * `!row.defaultHash` — user-created rows are inserted with a null hash).
 *
 * Sweep is unconditional for system rows — retired ids get removed even when
 * `hashFn(row) !== row.defaultHash`. Historical `hashModel` field-list
 * changes (e.g. `apiKey` removed via THU-505, `supportsParallelToolCalls`
 * added later) leave pre-existing rows with a stored `defaultHash` that no
 * longer matches a fresh recomputation, which under the previous "keep
 * edited rows" rule caused retired system models (Mistral Medium 3.1) to
 * stay stuck on user devices forever. The trade-off: a user who genuinely
 * customized a retired system model loses those tweaks — acceptable because
 * the backend routing for retired defaults is not guaranteed to remain, so
 * the row was already on borrowed time.
 *
 * Two independent gates:
 *   - `canOverwriteModels`: guards the model scan. When false (older bundle,
 *     or sync-incomplete-and-populated), we can't tell "unrecognized row" from
 *     "future default we don't yet know about", so we skip.
 *   - `initialSyncCompleted`: guards the profile scan. The profile loop
 *     trusts `aliveModelIds` derived from local state; that trust is only
 *     warranted when sync has finished. Otherwise a parent model whose
 *     alive-state hasn't synced yet could look "missing" locally and cause us
 *     to soft-delete a profile whose parent is actually still alive on cloud.
 */
export const cleanupRemovedDefaults = async (
  db: AnyDrizzleDatabase,
  canOverwriteModels: boolean = true,
  models: readonly SharedModel[] = defaultModels,
  initialSyncCompleted: boolean = true,
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
      // Sweep unconditionally — see docstring for the rationale (hash-field-
      // list drift produces false-positive "modified" state that would leave
      // retired system rows stuck on old devices).
      await db.update(modelsTable).set({ deletedAt: now }).where(eq(modelsTable.id, row.id))
      aliveModelIds.delete(row.id)
    }
  }

  // Profiles are 1:1 with models. Follow the parent model's fate — if the
  // parent isn't alive, sweep the profile too, unconditionally on hash-match
  // for the same reason the model loop does (schema-drift false positives).
  // User-created profiles (`!row.defaultHash`) are still exempt. Gated on
  // `initialSyncCompleted` so a mid-sync device (with a potentially partial
  // view of parent aliveness) stays fully non-mutating for the profiles table.
  if (!initialSyncCompleted) {
    return
  }
  const profiles = (await db
    .select()
    .from(modelProfilesTable)
    .where(isNull(modelProfilesTable.deletedAt))) as ModelProfile[]
  for (const row of profiles) {
    if (aliveModelIds.has(row.modelId) || !row.defaultHash) {
      continue
    }
    await db.update(modelProfilesTable).set({ deletedAt: now }).where(eq(modelProfilesTable.modelId, row.modelId))
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
    // Snapshot every reconciled table's row existence up front. Doing this
    // per-table just before each reconcile block would poison the settings
    // hasAnyRow probe on fresh installs: earlier tables advance their version
    // markers into settingsTable via `advanceVersionMarker`, so by the time
    // the settings block ran, the "empty settings table" signal would be
    // gone. Reading all five probes here — before any writes land in this
    // transaction — keeps every table's gate on the same pre-reconcile view.
    const hasAnyModelRow = (await tx.select({ id: modelsTable.id }).from(modelsTable).limit(1)).length > 0
    const hasAnyModeRow = (await tx.select({ id: modesTable.id }).from(modesTable).limit(1)).length > 0
    const hasAnyTaskRow = (await tx.select({ id: tasksTable.id }).from(tasksTable).limit(1)).length > 0
    const hasAnySkillRow = (await tx.select({ id: skillsTable.id }).from(skillsTable).limit(1)).length > 0
    const hasAnySettingsRow = (await tx.select({ key: settingsTable.key }).from(settingsTable).limit(1)).length > 0

    // Version gate for models. Returns the stored marker snapshot so the
    // per-table write-back can INSERT vs UPDATE without a second read. See
    // `computeCanOverwrite` for the full rationale — in short, prevents an
    // older-bundle device from downgrading newer synced rows (THU-637).
    // Modes/tasks/skills/settings gate the same way, folded into the loop
    // near the bottom of this transaction (THU-677).
    const modelsGate = await computeCanOverwrite(
      tx,
      versionMarkerKeys.models,
      modelsSource.version,
      hasAnyModelRow,
      initialSyncCompleted,
    )

    // OTA can ship models whose id isn't in this bundle's `defaultModelProfiles`
    // — profiles are not part of the OTA channel, so we have no profile to
    // pair with them. Inserting the model row alone violates the 1:1 model↔
    // profile invariant `insertMissing: true` is meant to preserve. Filter
    // those ids out and log the drop; cleanup still uses the unfiltered set
    // so a genuinely-shipped-elsewhere row (present locally via sync from a
    // newer-bundle peer) stays alive.
    const bundledProfileModelIds = new Set(defaultModelProfiles.map((p) => p.modelId))
    const modelsForReconcile = modelsSource.data.filter((m) => bundledProfileModelIds.has(m.id))
    const droppedOtaModelIds = modelsSource.data.filter((m) => !bundledProfileModelIds.has(m.id)).map((m) => m.id)
    if (droppedOtaModelIds.length > 0) {
      console.warn(
        `[reconcileDefaults] Dropped ${droppedOtaModelIds.length} OTA model(s) without a bundled profile: ` +
          `${droppedOtaModelIds.join(', ')}. OTA can only re-version or retire models this bundle knows; ` +
          `adding a new model id requires a client build so its profile ships alongside.`,
      )
    }

    // Soft-delete removed system defaults before reconciling current ones.
    // Cleanup uses the unfiltered OTA set so any id the server still ships
    // (including new-to-us ones synced from a newer-bundle peer) stays alive.
    //
    // Safety invariant enforced upstream by `pickModelsDefaults`:
    // `modelsSource.data` overlaps with `defaultModels` by at least one id.
    // A fully-disjoint payload would otherwise let cleanup soft-delete every
    // bundle-known row (none appear in the passed-in `currentModelIds`).
    await cleanupRemovedDefaults(tx, modelsGate.canOverwrite, modelsSource.data, initialSyncCompleted)

    // AI models. `canResurrect` uses initialSyncCompleted so an older-bundle
    // but fully-synced device can still un-delete a pre-THU-637 mistake, while
    // a mid-sync device stays non-mutating.
    //
    // `frozenFields` protects two identity-critical columns from OTA drift:
    // - `isConfidential`: an encrypted thread binds `isEncrypted` to the
    //   model's `isConfidential` at creation and the send guard enforces
    //   equality; a server slip that flips this on a live row would strand
    //   every encrypted thread bound to that id (see the Flash-fresh-id
    //   comment in `shared/defaults/models.ts`).
    // - `provider`: routes inference to the correct upstream; flipping it
    //   under an existing id would silently misroute or break sends.
    // OTA can still update name, description, contextWindow, tool flags, etc.
    // To change a frozen field, ship the new value under a fresh model id.
    const modelsPass = await reconcileDefaultsForTable(tx, modelsTable, modelsForReconcile, hashModel, {
      canOverwrite: modelsGate.canOverwrite,
      canResurrect: initialSyncCompleted,
      frozenFields: ['isConfidential', 'provider'],
    })

    // Model profiles ship 1:1 with models and mutate together in practice, so
    // they ride the same authority gate as models — otherwise an older-bundle
    // device would revert profile settings (temperature, tools, addenda) that
    // a newer bundle just shipped alongside its model changes, reintroducing
    // THU-637 on the profile side. `insertMissing: true` ensures a bundle-
    // known model always has its bundled profile to pair with, even when
    // canOverwrite is closed.
    //
    // Bounded to `modelsForReconcile`: this excludes both OTA-only-new ids
    // (no bundled profile exists) and OTA-retired ids (dropped from the
    // payload). Without this filter, `insertMissing: true` would insert a
    // profile for a model the OTA channel just retired — an orphan profile
    // with no live model — reintroducing the very 1:1 hazard `insertMissing`
    // exists to prevent, from the OTA-retire direction.
    const aliveModelIdsForReconcile = new Set(modelsForReconcile.map((m) => m.id))
    const profilesForReconcile = defaultModelProfiles.filter((p) => aliveModelIdsForReconcile.has(p.modelId))
    const profilesPass = await reconcileDefaultsForTable(
      tx,
      modelProfilesTable,
      profilesForReconcile,
      hashModelProfile,
      {
        keyField: 'modelId',
        canOverwrite: modelsGate.canOverwrite,
        insertMissing: true,
        canResurrect: initialSyncCompleted,
      },
    )

    // Advance the models version marker. Two conditions must hold together:
    //   1. `canOverwrite` — writing the marker under a closed gate would let
    //      peers falsely believe the picked version was applied here and stop
    //      their own in-place upgrades even though we never wrote the content.
    //   2. Something actually mutated. Advancing on a pure no-op (all rows
    //      user-edited, or all already at target) has the same false-signal
    //      hazard as (1) — we effectively promised to peers we're at version
    //      N without having verified our content matches N.
    // Extra `droppedOtaModelIds.length === 0` check for models: our apply is
    // a strict subset of the picked version when we filter OTA models, and
    // stamping the full version would lock later fuller-bundle clients
    // (canOverwrite=false because stored>=picked) out of inserting the
    // missing models.
    if (modelsGate.canOverwrite && (modelsPass.mutated || profilesPass.mutated) && droppedOtaModelIds.length === 0) {
      await advanceVersionMarker(tx, versionMarkerKeys.models, modelsSource.version, modelsGate.stored)
    }

    // Modes / tasks / skills / settings share the same shape: gate on the
    // per-table version + sync-incomplete guard, reconcile, advance marker
    // only on a real mutation. `canResurrect` follows the models pattern —
    // it requires a trustworthy view of cloud state, otherwise a peer's
    // genuine retirement could be masquerading as a cleanup shape from our
    // partial view. No `cleanupRemovedDefaults` call targets these tables
    // today, but resurrect still runs if a peer soft-deleted a bundle-known
    // row this device still ships as default. Skills note: they superseded
    // the legacy default automations that used to seed promptsTable here.
    // See THU-547.
    //
    // Each pass is wrapped in a generic helper so its `defaults`/`hashFn` T
    // binding is captured per-call — a `for-of` over a heterogeneous config
    // array would force TS to unify T across the union and fail to typecheck.
    const runGatedPass = async <T extends { defaultHash: string | null }>(
      table: SQLiteTableWithColumns<any>,
      defaults: readonly T[],
      hashFn: (item: T) => string,
      versionKey: string,
      currentVersion: number,
      hasAnyRow: boolean,
      keyField?: string,
    ): Promise<void> => {
      const gate = await computeCanOverwrite(tx, versionKey, currentVersion, hasAnyRow, initialSyncCompleted)
      const pass = await reconcileDefaultsForTable(tx, table, defaults, hashFn, {
        canOverwrite: gate.canOverwrite,
        canResurrect: initialSyncCompleted,
        ...(keyField ? { keyField } : {}),
      })
      if (gate.canOverwrite && pass.mutated) {
        await advanceVersionMarker(tx, versionKey, currentVersion, gate.stored)
      }
    }

    await runGatedPass(modesTable, defaultModes, hashMode, versionMarkerKeys.modes, defaultModesVersion, hasAnyModeRow)
    await runGatedPass(tasksTable, defaultTasks, hashTask, versionMarkerKeys.tasks, defaultTasksVersion, hasAnyTaskRow)
    await runGatedPass(
      skillsTable,
      defaultSkills,
      hashSkill,
      versionMarkerKeys.skills,
      defaultSkillsVersion,
      hasAnySkillRow,
    )
    await runGatedPass(
      settingsTable,
      defaultSettings,
      hashSetting,
      versionMarkerKeys.settings,
      defaultSettingsVersion,
      hasAnySettingsRow,
      'key',
    )

    // Initialize anonymous ID for analytics (unique per user)
    await createSetting(tx, 'anonymous_id', uuidv7())
  })
}
