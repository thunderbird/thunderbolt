import { and, desc, eq, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { modelsTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Model, ModelRow } from '../types'
import { getSettings } from './settings'
import { getLastMessage } from './chat-messages'
import { createDefaultModelProfile, deleteModelProfileForModel } from './model-profiles'

export const mapModel = (row: ModelRow): Model => {
  return {
    ...row,
    api_key: row.apiKey || undefined,
    is_system: row.isSystem || undefined,
  } as Model
}

/**
 * Gets all models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAllModelsQuery = () => {
  return DatabaseSingleton.instance.db
    .select()
    .from(modelsTable)
    .where(isNull(modelsTable.deletedAt))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)
}

export const getAllModels = async (): Promise<Model[]> => {
  const results = await getAllModelsQuery()
  return results.map(mapModel)
}

/**
 * Gets all available (enabled) models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAvailableModelsQuery = () => {
  return DatabaseSingleton.instance.db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.enabled, 1), isNull(modelsTable.deletedAt)))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)
}

export const getAvailableModels = async (): Promise<Model[]> => {
  const results = await getAvailableModelsQuery()
  return results.map(mapModel)
}

export const getModelQuery = (id: string) => {
  return DatabaseSingleton.instance.db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))
}

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
  const settings = await getSettings({ selected_model: String })
  const selectedModelId = settings.selectedModel

  if (selectedModelId) {
    const model = await getModel(selectedModelId)

    // Check if model exists and is enabled
    if (model?.id && model.enabled) {
      return model
    }
  }

  const systemModel = await getSystemModel()

  if (!systemModel) {
    throw new Error('No system model found')
  }

  return systemModel
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
