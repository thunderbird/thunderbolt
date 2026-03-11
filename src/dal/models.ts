import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { modelsTable, settingsTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Model, ModelRow } from '../types'
import { getLastMessage } from './chat-messages'
import { createDefaultModelProfile, deleteModelProfileForModel } from './model-profiles'

export const mapModel = (row: ModelRow): Model => {
  return {
    ...row,
    api_key: row.apiKey || undefined,
    is_system: row.isSystem || undefined,
  } as Model
}

/** Maps an array of ModelRow to Model[] */
export const mapModels = (rows: ModelRow[]): Model[] => rows.map(mapModel)

/**
 * Gets all models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAllModels = () => {
  return DatabaseSingleton.instance.db
    .select()
    .from(modelsTable)
    .where(isNull(modelsTable.deletedAt))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)
}

/**
 * Gets all available (enabled) models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAvailableModels = () => {
  return DatabaseSingleton.instance.db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.enabled, 1), isNull(modelsTable.deletedAt)))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)
}

export const getModelQuery = (id: string) => {
  return DatabaseSingleton.instance.db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))
}

/**
 * Returns a Drizzle query for the currently selected model, falling back to system model.
 * Use with PowerSync's toCompilableQuery, or await the result to execute.
 * Returns the selected model if it exists and is enabled; otherwise the system model.
 */
export const getSelectedModelQuery = () =>
  DatabaseSingleton.instance.db
    .select({ models: modelsTable })
    .from(modelsTable)
    .leftJoin(
      settingsTable,
      and(eq(settingsTable.key, 'selected_model'), eq(settingsTable.value, modelsTable.id), eq(modelsTable.enabled, 1)),
    )
    .where(and(isNull(modelsTable.deletedAt), or(eq(modelsTable.isSystem, 1), isNotNull(settingsTable.value))))
    .orderBy(sql`CASE WHEN ${settingsTable.value} IS NOT NULL THEN 0 ELSE 1 END`)
    .limit(1)

/**
 * Gets a specific model by ID (excluding soft-deleted)
 */
export const getModel = async (id: string): Promise<Model | null> => {
  const model = await getModelQuery(id).get()
  return model ? mapModel(model) : null
}

export const getSystemModel = async (): Promise<Model | null> => {
  const db = DatabaseSingleton.instance.db
  const systemModel = await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.isSystem, 1), isNull(modelsTable.deletedAt)))
    .orderBy(modelsTable.name)
    .get()
  return systemModel ? mapModel(systemModel) : null
}

/**
 * Gets the currently selected model or falls back to the system default model
 * If the selected model is disabled, automatically falls back to system model
 */
export const getSelectedModel = async (): Promise<Model> => {
  const result = await getSelectedModelQuery().all()
  const row = result[0]?.models
  if (!row) {
    throw new Error('No system model found')
  }
  return mapModel(row)
}

/**
 * Gets the default model for a chat thread based on the last message in the thread, falling back to the selected_model setting.
 * If any fallback model is disabled, continues to the next fallback option.
 */
export const getDefaultModelForThread = async (threadId: string, fallbackModelId?: string): Promise<Model> => {
  const lastMessage = await getLastMessage(threadId)

  if (lastMessage?.modelId) {
    const model = await getModel(lastMessage.modelId)

    if (model && model.enabled) {
      return model
    }
  }

  if (fallbackModelId) {
    const model = await getModel(fallbackModelId)

    if (model && model.enabled) {
      return model
    }
  }

  return await getSelectedModel()
}

/**
 * Update a model (preserves defaultHash for modification tracking)
 */
export const updateModel = async (id: string, updates: Partial<Model>): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Model> & { defaultHash?: string }
  await db.update(modelsTable).set(updateFields).where(eq(modelsTable.id, id))
}

/**
 * Reset a model to its default state
 */
export const resetModelToDefault = async (id: string, defaultModel: Model): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...defaultFields } = defaultModel
  await db.update(modelsTable).set(defaultFields).where(eq(modelsTable.id, id))
}

/**
 * Soft deletes a model by ID (sets deletedAt datetime)
 * Also soft-deletes all prompts referencing this model (and their triggers)
 * Scrubs all non-enum data for privacy
 * Only updates records that haven't been deleted yet to preserve original deletion datetimes
 */
export const deleteModel = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  // Dynamic import to avoid circular dependency: models → prompts → models (via getModel)
  const { deletePromptsForModel } = await import('./prompts')
  await db.transaction(async (tx) => {
    await deleteModelProfileForModel(id, tx)
    await deletePromptsForModel(id, tx)
    await tx
      .update(modelsTable)
      .set({ ...clearNullableColumns(modelsTable), deletedAt: nowIso() })
      .where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))
  })
}

/**
 * Creates a new model
 */
export const createModel = async (
  data: Partial<Model> & Pick<Model, 'id' | 'provider' | 'name' | 'model'>,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.transaction(async (tx) => {
    await tx.insert(modelsTable).values(data)
    await createDefaultModelProfile(data.id, tx)
  })
}
