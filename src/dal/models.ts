import { and, desc, eq, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { modelsTable } from '../db/tables'
import type { Model } from '../types'

const mapModel = (model: Model) => {
  return {
    ...model,
    api_key: model.apiKey || undefined,
    is_system: model.isSystem || undefined,
  }
}

/**
 * Gets all models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAllModels = async (): Promise<Model[]> => {
  const db = DatabaseSingleton.instance.db
  const results = await db
    .select()
    .from(modelsTable)
    .where(isNull(modelsTable.deletedAt))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)

  return results.map(mapModel)
}

/**
 * Gets all available (enabled) models from the database (excluding soft-deleted)
 * Sorted with system models first, then alphabetically by name
 */
export const getAvailableModels = async (): Promise<Model[]> => {
  const db = DatabaseSingleton.instance.db
  const results = await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.enabled, 1), isNull(modelsTable.deletedAt)))
    .orderBy(desc(modelsTable.isSystem), modelsTable.name)
  return results.map(mapModel)
}

/**
 * Gets a specific model by ID (excluding soft-deleted)
 */
export const getModel = async (id: string): Promise<Model | null> => {
  const db = DatabaseSingleton.instance.db
  const model = await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))
    .get()
  return model ? mapModel(model) : null
}

export const getSystemModel = async (): Promise<Model | null> => {
  const db = DatabaseSingleton.instance.db
  const systemModel = await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.isSystem, 1), isNull(modelsTable.deletedAt)))
    .get()
  return systemModel ? mapModel(systemModel) : null
}

/**
 * Gets the currently selected model or falls back to the system default model
 * If the selected model is disabled, automatically falls back to system model
 */
export const getSelectedModel = async (): Promise<Model> => {
  // Import locally to avoid circular dependency
  const { getSettings } = await import('./settings')

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
  // Import locally to avoid circular dependency
  const { getLastMessage } = await import('./chat-messages')

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
 * Deletes a model by ID
 */
export const deleteModel = async (id: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.delete(modelsTable).where(eq(modelsTable.id, id))
}

/**
 * Creates a new model
 */
export const createModel = async (
  data: Partial<Model> & Pick<Model, 'id' | 'provider' | 'name' | 'model'>,
): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(modelsTable).values(data)
}
