/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { modelProfilesTable } from '../db/tables'
import { defaultModelProfiles, hashModelProfile } from '../defaults/model-profiles'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { ModelProfile, ModelProfileRow } from '../types'

const mapProfile = (row: ModelProfileRow): ModelProfile => row as ModelProfile

/** Get profile for a model in the given workspace (excluding soft-deleted) */
export const getModelProfile = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  modelId: string,
): Promise<ModelProfile | null> => {
  const profile = await db
    .select()
    .from(modelProfilesTable)
    .where(
      and(
        eq(modelProfilesTable.workspaceId, workspaceId),
        eq(modelProfilesTable.modelId, modelId),
        isNull(modelProfilesTable.deletedAt),
      ),
    )
    .get()
  return profile ? mapProfile(profile) : null
}

/** Upsert a profile in the given workspace (insert or update, handles soft-deleted rows atomically) */
export const upsertModelProfile = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  data: Partial<ModelProfile> & Pick<ModelProfile, 'modelId'>,
): Promise<void> => {
  // Strip `defaultHash` (preserved for modification tracking) and `workspaceId`
  // from the UPDATE branch — the row stays in the workspace it was filtered to.
  // The INSERT branch still gets `workspaceId` via the explicit param below.
  const {
    defaultHash,
    workspaceId: _workspaceId,
    ...updateFields
  } = data as Partial<ModelProfile> & { defaultHash?: string | null }
  await db
    .insert(modelProfilesTable)
    .values({ ...data, workspaceId })
    .onConflictDoUpdate({
      target: modelProfilesTable.modelId,
      set: { ...updateFields, deletedAt: null },
      // Restrict the UPDATE branch to the matching workspace so a second
      // workspace's upsert for the same modelId doesn't overwrite the first's row.
      // SQLite treats a false setWhere as DO NOTHING — no error, no cross-workspace mutation.
      setWhere: eq(modelProfilesTable.workspaceId, workspaceId),
    })
}

/** Create default profile for a model in the given workspace using seed data */
export const createDefaultModelProfile = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  modelId: string,
): Promise<void> => {
  const defaultProfile = defaultModelProfiles.find((p) => p.modelId === modelId)
  if (!defaultProfile) {
    return
  }

  await db
    .insert(modelProfilesTable)
    .values({
      ...defaultProfile,
      defaultHash: hashModelProfile(defaultProfile),
      workspaceId,
    })
    .onConflictDoNothing()
}

/** Soft-delete profile for a model in the given workspace */
export const deleteModelProfileForModel = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  modelId: string,
): Promise<void> => {
  await db
    .update(modelProfilesTable)
    .set({ ...clearNullableColumns(modelProfilesTable), deletedAt: nowIso() })
    .where(
      and(
        eq(modelProfilesTable.workspaceId, workspaceId),
        eq(modelProfilesTable.modelId, modelId),
        isNull(modelProfilesTable.deletedAt),
      ),
    )
}

/** Reset a profile in the given workspace to its default values */
export const resetModelProfileToDefault = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  modelId: string,
): Promise<void> => {
  const defaultProfile = defaultModelProfiles.find((p) => p.modelId === modelId)
  if (!defaultProfile) {
    return
  }

  // Drop `workspaceId` from `fields` so the SET doesn't reassign the row to
  // the (typically null) value baked into the seed default — the row must
  // stay in the workspace the reset was scoped to.
  const {
    defaultHash,
    workspaceId: _seedWorkspaceId,
    ...fields
  } = defaultProfile as ModelProfile & {
    defaultHash?: string | null
  }
  await db
    .update(modelProfilesTable)
    .set({
      ...fields,
      defaultHash: hashModelProfile(defaultProfile),
      deletedAt: null,
    })
    .where(and(eq(modelProfilesTable.workspaceId, workspaceId), eq(modelProfilesTable.modelId, modelId)))
}
