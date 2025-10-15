import { and, asc, desc, eq, isNotNull, isNull, like, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseSingleton } from '../db/singleton'
import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from '../db/tables'
import type { AutomationRun, Model, Prompt, Setting, Task, ThunderboltUIMessage, UIMessageMetadata } from '../types'
import { serializeValue } from './serialization'
import { camelCased, convertUIMessageToDbChatMessage } from './utils'

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
  const settings = await getSettings({ selected_model: String })
  const selectedModelId = settings.selectedModel

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
 * Type schema for settings - maps keys to their value types or default values
 */
type SettingSchema = Record<
  string,
  string | number | boolean | null | StringConstructor | BooleanConstructor | NumberConstructor
>

/**
 * Gets raw setting records for a schema object
 * Returns the full Setting objects with metadata
 *
 * @param schema - Object mapping setting keys to either type constructors or default values
 * @returns Record of setting keys to Setting objects
 *
 * @example
 * ```ts
 * const settings = await getSettingsRecords({
 *   cloud_url: String,
 *   max_retries: 3,
 *   is_enabled: true,
 * })
 * // Returns: { cloud_url: Setting, max_retries: Setting, is_enabled: Setting }
 * ```
 */
export const getSettingsRecords = async <T extends SettingSchema>(schema: T): Promise<Record<string, Setting>> => {
  const keys = Object.keys(schema)
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
 * Helper type to convert snake_case to camelCase
 */
type CamelCaseKey<S extends string> = S extends `${infer P1}_${infer P2}` ? `${P1}${Capitalize<CamelCaseKey<P2>>}` : S

/**
 * Result type that conditionally applies camelCase transformation
 */
type GetSettingsResult<T extends SettingSchema, CamelCase extends boolean> = CamelCase extends true
  ? {
      [K in keyof T as K extends string ? CamelCaseKey<K> : K]: T[K] extends StringConstructor
        ? string | null
        : T[K] extends BooleanConstructor
          ? boolean
          : T[K] extends NumberConstructor
            ? number | null
            : T[K] extends true | false
              ? boolean
              : T[K] extends boolean
                ? boolean
                : T[K] extends number
                  ? number
                  : T[K] extends string
                    ? string
                    : T[K] extends null
                      ? null
                      : never
    }
  : {
      [K in keyof T]: T[K] extends StringConstructor
        ? string | null
        : T[K] extends BooleanConstructor
          ? boolean
          : T[K] extends NumberConstructor
            ? number | null
            : T[K] extends true | false
              ? boolean
              : T[K] extends boolean
                ? boolean
                : T[K] extends number
                  ? number
                  : T[K] extends string
                    ? string
                    : T[K] extends null
                      ? null
                      : never
    }

/**
 * Gets settings values for a schema object
 * Returns only the values (not the full Setting records)
 * Values are properly typed based on the schema
 *
 * @param schema - Object mapping setting keys to either type constructors or default values
 * @param options - Optional configuration
 * @param options.camelCase - If true (default), converts snake_case keys to camelCase in the result
 * @returns Object with key-value pairs for the requested settings
 *
 * @example
 * ```ts
 * // With camelCase (default)
 * const settings = await getSettings({
 *   cloud_url: String,           // Returns as cloudUrl: string | null
 *   max_retries: 3,               // Returns as maxRetries: number (defaults to 3)
 *   is_enabled: true,             // Returns as isEnabled: boolean (defaults to true)
 * })
 * // settings = { cloudUrl: string | null, maxRetries: number, isEnabled: boolean }
 *
 * // Without camelCase
 * const settings = await getSettings({
 *   cloud_url: String,
 *   max_retries: 3,
 * }, { camelCase: false })
 * // settings = { cloud_url: string | null, max_retries: number }
 * ```
 */
export function getSettings<T extends SettingSchema>(schema: T): Promise<GetSettingsResult<T, true>>
export function getSettings<T extends SettingSchema>(
  schema: T,
  options: { camelCase: true },
): Promise<GetSettingsResult<T, true>>
export function getSettings<T extends SettingSchema>(
  schema: T,
  options: { camelCase: false },
): Promise<GetSettingsResult<T, false>>
export async function getSettings<T extends SettingSchema>(
  schema: T,
  options: { camelCase?: boolean } = {},
): Promise<GetSettingsResult<T, boolean>> {
  const { camelCase = true } = options
  const keys = Object.keys(schema)
  const db = DatabaseSingleton.instance.db

  const results = await Promise.all(
    keys.map((key) => db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()),
  )

  const result: Record<string, string | number | boolean | null> = {}

  for (const key of keys) {
    const schemaValue = schema[key]
    const setting = results.find((r) => r?.key === key)

    // Determine if this is a constructor or a default value
    const isConstructor = typeof schemaValue === 'function'
    const defaultValue = isConstructor ? (schemaValue === Boolean ? false : null) : schemaValue

    // Determine the type hint for deserialization
    const typeHint = isConstructor
      ? schemaValue === String
        ? 'string'
        : schemaValue === Boolean
          ? 'boolean'
          : schemaValue === Number
            ? 'number'
            : 'string'
      : typeof defaultValue === 'boolean'
        ? 'boolean'
        : typeof defaultValue === 'number'
          ? 'number'
          : 'string'

    // Deserialize the value
    const deserializedValue =
      setting?.value !== null && setting?.value !== undefined
        ? typeHint === 'boolean'
          ? setting.value === 'true'
          : typeHint === 'number'
            ? Number(setting.value)
            : setting.value
        : null

    // Apply default if value is null/undefined
    const value = (deserializedValue ?? defaultValue) as string | number | boolean | null

    // Store with camelCase key if requested
    const resultKey = camelCase ? camelCased(key) : key
    result[resultKey] = value
  }

  return result as GetSettingsResult<T, typeof camelCase>
}

/**
 * Gets theme setting with proper typing
 */
export const getThemeSetting = async (storageKey: string, defaultTheme: string): Promise<string> => {
  const settings = await getSettings({ [storageKey]: defaultTheme })
  const camelKey = camelCased(storageKey)
  return settings[camelKey]
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
 * Get a boolean setting value from the settings table
 */
export const getBooleanSetting = async (key: string, defaultValue: boolean = false): Promise<boolean> => {
  const settings = await getSettings({ [key]: defaultValue })
  const camelKey = camelCased(key)
  return settings[camelKey]
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
 * @param key - The setting key
 * @param value - The value (can be string, null, boolean, number, or JSON-serializable object)
 */
export const updateSetting = async (key: string, value: any): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  const stringValue = serializeValue(value)
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

  // Get the last message in the thread to use as parent for new messages
  const lastMessage = await getLastMessage(threadId)
  const parentId = lastMessage?.id ?? null

  // Convert UI messages to DB messages with parent relationship
  const dbChatMessages = messages.map((message, index) => {
    // For the first message in this batch, use the last message in the thread as parent
    // For subsequent messages in the batch, use the previous message in the batch
    const messageParentId = index === 0 ? parentId : messages[index - 1].id
    return convertUIMessageToDbChatMessage(message, threadId, messageParentId)
  })

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
        parentId: sql`excluded.parent_id`,
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
 * Delete an automation (soft delete) and its associated triggers
 */
export const deleteAutomation = async (id: string) => {
  const db = DatabaseSingleton.instance.db
  // Delete triggers first (due to foreign key)
  await db.delete(triggersTable).where(eq(triggersTable.promptId, id))
  // Use soft delete - set deletedAt timestamp instead of hard delete
  await db.update(promptsTable).set({ deletedAt: Date.now() }).where(eq(promptsTable.id, id))
}

/**
 * Runs an automation by creating a new chat thread and seeding it with the prompt
 * @returns The threadId of the newly created chat thread
 */
export const runAutomation = async (promptId: string): Promise<string> => {
  const db = DatabaseSingleton.instance.db

  const prompt = await db
    .select()
    .from(promptsTable)
    .where(and(eq(promptsTable.id, promptId), isNull(promptsTable.deletedAt)))
    .get()
  if (!prompt) throw new Error('Prompt not found')

  const model = await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.id, prompt.modelId), isNull(modelsTable.deletedAt)))
    .get()
  if (!model) throw new Error('Model not found')

  const threadId = uuidv7()

  await db.insert(chatThreadsTable).values({
    id: threadId,
    title: prompt.title ?? 'Automation',
    triggeredBy: prompt.id,
    wasTriggeredByAutomation: 1,
  })

  const userMessage = {
    id: uuidv7(),
    role: 'user' as const,
    metadata: { modelId: model.id },
    parts: [{ type: 'text' as const, text: prompt.prompt }],
  }

  await db.insert(chatMessagesTable).values(convertUIMessageToDbChatMessage(userMessage, threadId, null))

  return threadId
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
