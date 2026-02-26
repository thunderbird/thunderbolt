import { and, eq, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { modelProfilesTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { ModelProfile, ModelProfileRow } from '../types'

const mapProfile = (row: ModelProfileRow): ModelProfile => row as ModelProfile

/** Get profile for a model (excluding soft-deleted) */
export const getModelProfile = async (modelId: string): Promise<ModelProfile | null> => {
  const db = DatabaseSingleton.instance.db
  const profile = await db
    .select()
    .from(modelProfilesTable)
    .where(and(eq(modelProfilesTable.modelId, modelId), isNull(modelProfilesTable.deletedAt)))
    .get()
  return profile ? mapProfile(profile) : null
}

/** Upsert a profile (insert or update, handles soft-deleted rows atomically) */
export const upsertModelProfile = async (
  data: Partial<ModelProfile> & Pick<ModelProfile, 'modelId'>,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...updateFields } = data as Partial<ModelProfile> & { defaultHash?: string | null }
  await db
    .insert(modelProfilesTable)
    .values(data)
    .onConflictDoUpdate({
      target: modelProfilesTable.modelId,
      set: { ...updateFields, deletedAt: null },
    })
}

/** Create default profile for a model using seed data */
export const createDefaultModelProfile = async (modelId: string): Promise<void> => {
  // Lazy import to avoid circular dependency
  const { defaultModelProfiles, hashModelProfile } = await import('../defaults/model-profiles')
  const defaultProfile = defaultModelProfiles.find((p) => p.modelId === modelId)
  if (!defaultProfile) return

  const db = DatabaseSingleton.instance.db
  await db
    .insert(modelProfilesTable)
    .values({
      ...defaultProfile,
      defaultHash: hashModelProfile(defaultProfile),
    })
    .onConflictDoNothing()
}

/** Soft-delete profile for a model */
export const deleteModelProfileForModel = async (modelId: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db
    .update(modelProfilesTable)
    .set({ ...clearNullableColumns(modelProfilesTable), deletedAt: nowIso() })
    .where(and(eq(modelProfilesTable.modelId, modelId), isNull(modelProfilesTable.deletedAt)))
}

/** Reset a profile to its default values */
export const resetModelProfileToDefault = async (modelId: string): Promise<void> => {
  const { defaultModelProfiles, hashModelProfile } = await import('../defaults/model-profiles')
  const defaultProfile = defaultModelProfiles.find((p) => p.modelId === modelId)
  if (!defaultProfile) return

  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...fields } = defaultProfile as ModelProfile & { defaultHash?: string | null }
  await db
    .update(modelProfilesTable)
    .set({
      ...fields,
      defaultHash: hashModelProfile(defaultProfile),
      deletedAt: null,
    })
    .where(eq(modelProfilesTable.modelId, modelId))
}
