import { and, asc, desc, eq, isNotNull, isNull, like, sql } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
} from '../db/tables'
import type { AutomationRun, Model, Prompt, Setting, Task, ThunderboltUIMessage, UIMessageMetadata } from '../types'
import { convertUIMessageToDbChatMessage } from './utils'

// ============================================================================
// MODELS
// ============================================================================

const mapModel = (model: Model) => {
  return {
    ...model,
    api_key: model.apiKey || undefined,
    is_system: model.isSystem || undefined,
  }
}

/**
 * Gets all models from the database (excluding soft-deleted)
 */
export const getAllModels = async (): Promise<Model[]> => {
  const db = DatabaseSingleton.instance.db
  const results = await db.select().from(modelsTable).where(isNull(modelsTable.deletedAt))

  return results.map(mapModel)
}

/**
 * Gets all available (enabled) models from the database (excluding soft-deleted)
 */
export const getAvailableModels = async (): Promise<Model[]> => {
  const db = DatabaseSingleton.instance.db
  const results = await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.enabled, 1), isNull(modelsTable.deletedAt)))
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

export const getSystemModel = async () => {
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
 */
export const getSelectedModel = async (): Promise<Model> => {
  const selectedModelId = await getSetting('selected_model')

  if (selectedModelId) {
    const model = await getModel(selectedModelId)

    if (model?.id) {
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
 */
export const getDefaultModelForThread = async (threadId: string, fallbackModelId?: string): Promise<Model> => {
  const lastMessage = await getLastMessage(threadId)

  if (lastMessage?.modelId) {
    const model = await getModel(lastMessage.modelId)

    if (model) {
      return model
    }
  }

  if (fallbackModelId) {
    const model = await getModel(fallbackModelId)

    if (model) {
      return model
    }
  }

  return await getSelectedModel()
}

// ============================================================================
// SETTINGS
// ============================================================================

/**
 * Gets all settings from the database
 */
export const getAllSettings = async () => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(settingsTable)
}

/**
 * Gets raw settings rows for specific keys
 */
export const getRawSettings = async (keys: string[]) => {
  const db = DatabaseSingleton.instance.db
  const results = await Promise.all(
    keys.map((key) => db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()),
  )
  return results.reduce(
    (acc, setting) => {
      if (setting) {
        acc[setting.key] = setting
      }
      return acc
    },
    {} as Record<string, Setting>,
  )
}

/**
 * Gets theme setting with proper typing
 */
export const getThemeSetting = async (storageKey: string, defaultTheme: string): Promise<string> => {
  const result = await getSetting(storageKey, defaultTheme)
  return result
}

/**
 * Check if a setting exists in the settings table
 */
export const hasSetting = async (key: string): Promise<boolean> => {
  const db = DatabaseSingleton.instance.db
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(settingsTable)
    .where(eq(settingsTable.key, key))
    .get()
  return (result?.count ?? 0) > 0
}

/**
 * Get a setting value from the settings table
 */
export const getSetting = async <T = string, V = T | null>(key: string, defaultValue: V = null as V): Promise<V> => {
  const db = DatabaseSingleton.instance.db
  const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
  return (setting?.value as V) ?? defaultValue
}

/**
 * Get a boolean setting value from the settings table
 */
export const getBooleanSetting = async (key: string, defaultValue: boolean = false): Promise<boolean> => {
  const setting = await getSetting(key, defaultValue.toString())
  return setting === 'true'
}

/**
 * Create a setting only if it doesn't already exist
 * Does nothing if the setting already exists (preserves existing value)
 */
export const createSetting = async (key: string, value: string | null): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(settingsTable).values({ key, value }).onConflictDoNothing()
}

/**
 * Update or create a setting in the settings table
 * Accepts string, null, or boolean values. Booleans are stored as 'true'/'false' strings.
 */
export const updateSetting = async (key: string, value: string | null | boolean): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  const stringValue = typeof value === 'boolean' ? (value ? 'true' : 'false') : value
  await db
    .insert(settingsTable)
    .values({ key, value: stringValue })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: stringValue },
    })
}

/**
 * Delete a setting from the settings table
 * Useful for removing user overrides so the code default is used
 */
export const deleteSetting = async (key: string): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.delete(settingsTable).where(eq(settingsTable.key, key))
}

// ============================================================================
// CHAT THREADS
// ============================================================================

/**
 * Gets all chat threads ordered by creation date
 */
export const getAllChatThreads = async () => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(chatThreadsTable).orderBy(desc(chatThreadsTable.id))
}

/**
 * Gets a specific chat thread by ID
 */
export const getChatThread = async (id: string) => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()
}

/**
 * Create a new chat thread
 */
export const createChatThread = async (id: string) => {
  const db = DatabaseSingleton.instance.db
  await db.insert(chatThreadsTable).values({ id, title: 'New Chat' })
}

/**
 * Gets a specific chat thread by ID or create a new one with the provided ID
 */
export const getOrCreateChatThread = async (id: string) => {
  const thread = await getChatThread(id)

  if (thread?.id) {
    return thread
  }

  await createChatThread(id)

  return await getChatThread(id)
}

// ============================================================================
// CHAT MESSAGES
// ============================================================================

/**
 * Gets all chat messages for a specific thread
 */
export const getChatMessages = async (threadId: string) => {
  const db = DatabaseSingleton.instance.db
  const chatMessages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatThreadId, threadId))
    .orderBy(chatMessagesTable.id)
  return chatMessages
}

export const getLastMessage = async (threadId: string) => {
  const db = DatabaseSingleton.instance.db

  return await db
    .select({
      id: chatMessagesTable.id,
      chatThreadId: chatMessagesTable.chatThreadId,
      modelId: chatMessagesTable.modelId,
    })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatThreadId, threadId))
    .orderBy(desc(chatMessagesTable.id))
    .limit(1)
    .get()
}

// ============================================================================
// TASKS
// ============================================================================

/**
 * Gets all incomplete tasks, optionally filtered by search query
 */
export const getIncompleteTasks = async (searchQuery?: string): Promise<Task[]> => {
  const db = DatabaseSingleton.instance.db
  const query = db
    .select()
    .from(tasksTable)
    .where(
      searchQuery
        ? and(eq(tasksTable.isComplete, 0), like(tasksTable.item, `%${searchQuery}%`))
        : eq(tasksTable.isComplete, 0),
    )
    .orderBy(asc(tasksTable.order), desc(tasksTable.id))
    .limit(50)

  const result = await query
  return result.filter((task) => task.item && task.item.trim() !== '')
}

/**
 * Gets the count of incomplete tasks
 */
export const getIncompleteTasksCount = async (): Promise<number> => {
  const db = DatabaseSingleton.instance.db
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasksTable)
    .where(eq(tasksTable.isComplete, 0))
  return count
}

// ============================================================================
// MCP SERVERS
// ============================================================================

/**
 * Gets all MCP servers from the database
 */
export const getAllMcpServers = async () => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(mcpServersTable)
}

/**
 * Gets all HTTP MCP servers with non-null URLs from the database
 */
export const getHttpMcpServers = async () => {
  const db = DatabaseSingleton.instance.db
  const allServers = await db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.type, 'http'), isNotNull(mcpServersTable.url)))

  return allServers.map((server) => ({
    id: server.id,
    name: server.name,
    url: server.url as string,
    enabled: server.enabled,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  }))
}

// ============================================================================
// PROMPTS
// ============================================================================

/**
 * Gets all prompts, optionally filtered by search query
 */
export const getAllPrompts = async (searchQuery?: string): Promise<Prompt[]> => {
  const db = DatabaseSingleton.instance.db
  if (searchQuery) {
    return db
      .select()
      .from(promptsTable)
      .where(and(like(promptsTable.prompt, `%${searchQuery}%`), isNull(promptsTable.deletedAt)))
      .orderBy(asc(promptsTable.id))
      .limit(50)
  }

  return db.select().from(promptsTable).where(isNull(promptsTable.deletedAt)).orderBy(asc(promptsTable.id)).limit(50)
}

/**
 * Returns information about the automation that triggered a chat thread, if any.
 */
export const getTriggerPromptForThread = async (threadId: string): Promise<AutomationRun | null> => {
  const db = DatabaseSingleton.instance.db

  // Fetch the associated prompt and thread info in a single query via join
  const result = await db
    .select({
      prompt: promptsTable,
      wasTriggeredByAutomation: chatThreadsTable.wasTriggeredByAutomation,
      triggeredBy: chatThreadsTable.triggeredBy,
    })
    .from(chatThreadsTable)
    .leftJoin(promptsTable, eq(chatThreadsTable.triggeredBy, promptsTable.id))
    .where(eq(chatThreadsTable.id, threadId))
    .get()

  if (!result) return null

  const wasTriggeredByAutomation = result.wasTriggeredByAutomation === 1
  const isAutomationDeleted = wasTriggeredByAutomation && !result.prompt

  return {
    prompt: result.prompt,
    wasTriggeredByAutomation,
    isAutomationDeleted,
  }
}

/**
 * Gets the context size for a chat thread
 * @param threadId - The ID of the chat thread
 * @returns The context size in tokens, or null if not found/not known
 */
export const getContextSizeForThread = async (threadId: string): Promise<number | null> => {
  const db = DatabaseSingleton.instance.db
  const thread = await db
    .select({ contextSize: chatThreadsTable.contextSize })
    .from(chatThreadsTable)
    .where(eq(chatThreadsTable.id, threadId))
    .get()

  return thread?.contextSize ?? null
}

/**
 * Saves messages to a chat thread and updates context size if available
 * @param threadId - The ID of the chat thread
 * @param messages - Array of UI messages to save
 * @returns The saved database messages
 * @throws Error if thread is not found
 */
export const saveMessagesWithContextUpdate = async (threadId: string, messages: ThunderboltUIMessage[]) => {
  const db = DatabaseSingleton.instance.db

  // Verify thread exists
  const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
  if (!thread) {
    throw new Error('Thread not found')
  }

  // Convert UI messages to DB messages
  const dbChatMessages = messages.map((message) => convertUIMessageToDbChatMessage(message, threadId))

  // Insert messages
  await db
    .insert(chatMessagesTable)
    .values(dbChatMessages)
    .onConflictDoUpdate({
      target: chatMessagesTable.id,
      set: {
        content: sql`excluded.content`,
        parts: sql`excluded.parts`,
        role: sql`excluded.role`,
      },
    })

  // Update context size if available in latest message
  const latestMessage = messages[messages.length - 1]
  const metadata = latestMessage?.metadata as UIMessageMetadata | undefined

  if (metadata?.usage?.totalTokens) {
    await db
      .update(chatThreadsTable)
      .set({ contextSize: metadata.usage.totalTokens })
      .where(eq(chatThreadsTable.id, threadId))
  }

  return dbChatMessages
}

// ============================================================================
// DEFAULTS MANAGEMENT
// ============================================================================

/**
 * Update a model (preserves defaultHash for modification tracking)
 */
export const updateModel = async (id: string, updates: Partial<Model>) => {
  const db = DatabaseSingleton.instance.db
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Model> & { defaultHash?: string }
  await db.update(modelsTable).set(updateFields).where(eq(modelsTable.id, id))
}

/**
 * Reset a model to its default state
 */
export const resetModelToDefault = async (id: string, defaultModel: Model) => {
  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...defaultFields } = defaultModel
  await db.update(modelsTable).set(defaultFields).where(eq(modelsTable.id, id))
}

/**
 * Update an automation/prompt (preserves defaultHash for modification tracking)
 */
export const updateAutomation = async (id: string, updates: Partial<Prompt>) => {
  const db = DatabaseSingleton.instance.db
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Prompt> & { defaultHash?: string }
  await db.update(promptsTable).set(updateFields).where(eq(promptsTable.id, id))
}

/**
 * Reset an automation to its default state
 */
export const resetAutomationToDefault = async (id: string, defaultAutomation: Prompt) => {
  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...defaultFields } = defaultAutomation
  await db.update(promptsTable).set(defaultFields).where(eq(promptsTable.id, id))
}

/**
 * Reset a setting to its default state
 */
export const resetSettingToDefault = async (key: string, defaultSetting: Setting) => {
  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...defaultFields } = defaultSetting
  await db.update(settingsTable).set(defaultFields).where(eq(settingsTable.key, key))
}

/**
 * Update a task (preserves defaultHash for modification tracking)
 */
export const updateTask = async (id: string, updates: Partial<Task>) => {
  const db = DatabaseSingleton.instance.db
  // Don't allow updating defaultHash - it must be preserved for modification tracking
  const { defaultHash, ...updateFields } = updates as Partial<Task> & { defaultHash?: string }
  await db.update(tasksTable).set(updateFields).where(eq(tasksTable.id, id))
}

/**
 * Reset a task to its default state
 */
export const resetTaskToDefault = async (id: string, defaultTask: Task) => {
  const db = DatabaseSingleton.instance.db
  const { defaultHash, ...defaultFields } = defaultTask
  await db.update(tasksTable).set(defaultFields).where(eq(tasksTable.id, id))
}
