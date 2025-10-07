import { and, asc, desc, eq, isNotNull, like, sql } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import {
  accountsTable,
  chatMessagesTable,
  chatThreadsTable,
  emailMessagesTable,
  emailThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
} from '../db/tables'
import type {
  AutomationRun,
  EmailThreadWithMessagesAndAddresses,
  Model,
  Prompt,
  Task,
  ThunderboltUIMessage,
  UIMessageMetadata,
} from '../types'
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
 * Gets all models from the database
 */
export const getAllModels = async (): Promise<Model[]> => {
  const db = DatabaseSingleton.instance.db
  const results = await db.select().from(modelsTable)

  return results.map(mapModel)
}

/**
 * Gets all available (enabled) models from the database
 */
export const getAvailableModels = async (): Promise<Model[]> => {
  const db = DatabaseSingleton.instance.db
  const results = await db.select().from(modelsTable).where(eq(modelsTable.enabled, 1))
  return results.map(mapModel)
}

/**
 * Gets a specific model by ID
 */
export const getModel = async (id: string): Promise<Model | null> => {
  const db = DatabaseSingleton.instance.db
  const model = await db.select().from(modelsTable).where(eq(modelsTable.id, id)).get()
  return model ? mapModel(model) : null
}

export const getSystemModel = async () => {
  const db = DatabaseSingleton.instance.db
  const systemModel = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1)).get()
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
 * Gets preferences settings with specific structure
 */
export const getPreferencesSettings = async () => {
  const locationName = await getSetting('location_name', '')
  const locationLat = await getSetting('location_lat', '')
  const locationLng = await getSetting('location_lng', '')
  const preferredName = await getSetting('preferred_name', '')
  const dataCollection = await getBooleanSetting('data_collection', true)
  const experimentalFeatureTasks = await getBooleanSetting('experimental_feature_tasks', false)

  return {
    locationName,
    locationLat,
    locationLng,
    preferredName,
    dataCollection,
    experimentalFeatureTasks,
  }
}

/**
 * Gets theme setting with proper typing
 */
export const getThemeSetting = async (storageKey: string, defaultTheme: string): Promise<string> => {
  const result = await getSetting(storageKey, defaultTheme)
  return result
}

/**
 * Gets bridge settings with specific structure
 */
export const getBridgeSettings = async () => {
  const enabled = await getBooleanSetting('bridge_enabled', false)
  return {
    enabled,
  }
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
 */
export const updateSetting = async (key: string, value: string | null): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({
    target: settingsTable.key,
    set: { value },
  })
}

export const updateBooleanSetting = async (key: string, value: boolean): Promise<void> => {
  const db = DatabaseSingleton.instance.db
  await db
    .insert(settingsTable)
    .values({ key, value: value ? 'true' : 'false' })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: value ? 'true' : 'false' },
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
// ACCOUNTS
// ============================================================================

/**
 * Gets all accounts from the database
 */
export const getAllAccounts = async () => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(accountsTable)
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
      .where(like(promptsTable.prompt, `%${searchQuery}%`))
      .orderBy(asc(promptsTable.id))
      .limit(50)
  }

  return db.select().from(promptsTable).orderBy(asc(promptsTable.id)).limit(50)
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

// ============================================================================
// EMAIL THREADS
// ============================================================================

export const getEmailThreadWithMessages = async (
  emailThreadId: string,
): Promise<EmailThreadWithMessagesAndAddresses | null> => {
  const db = DatabaseSingleton.instance.db
  const thread = await db.select().from(emailThreadsTable).where(eq(emailThreadsTable.id, emailThreadId)).get()

  if (!thread) return null

  const messages = await db.query.emailMessagesTable.findMany({
    where: eq(emailMessagesTable.emailThreadId, emailThreadId),
    with: {
      sender: true,
      recipients: {
        with: {
          address: true,
        },
      },
    },
    orderBy: (messages, { asc }) => [asc(messages.sentAt)],
  })
  return { ...thread, messages }
}

export const getEmailThreadByMessageImapIdWithMessages = async (
  imapId: string,
): Promise<EmailThreadWithMessagesAndAddresses | null> => {
  const db = DatabaseSingleton.instance.db
  const message = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.imapId, imapId)).get()

  if (!message || !message.emailThreadId) return null

  const thread = await db.select().from(emailThreadsTable).where(eq(emailThreadsTable.id, message.emailThreadId)).get()

  if (!thread) return null

  const messages = await db.query.emailMessagesTable.findMany({
    where: eq(emailMessagesTable.emailThreadId, thread.id),
    with: {
      sender: true,
      recipients: {
        with: {
          address: true,
        },
      },
    },
    orderBy: (messages, { asc }) => [asc(messages.sentAt)],
  })

  return { ...thread, messages }
}

export const getEmailThreadByMessageIdWithMessages = async (
  emailMessageId: string,
): Promise<EmailThreadWithMessagesAndAddresses | null> => {
  const db = DatabaseSingleton.instance.db
  const message = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.id, emailMessageId)).get()

  if (!message || !message.emailThreadId) return null

  const thread = await db.select().from(emailThreadsTable).where(eq(emailThreadsTable.id, message.emailThreadId)).get()

  if (!thread) return null

  const messages = await db.query.emailMessagesTable.findMany({
    where: eq(emailMessagesTable.emailThreadId, thread.id),
    with: {
      sender: true,
      recipients: {
        with: {
          address: true,
        },
      },
    },
    orderBy: (messages, { asc }) => [asc(messages.sentAt)],
  })

  return { ...thread, messages }
}

// ============================================================================
// EMAIL MESSAGES
// ============================================================================

/**
 * Gets an email message by ID with sender and recipients
 */
export const getEmailMessage = async (messageId: string) => {
  const db = DatabaseSingleton.instance.db
  const message = await db.query.emailMessagesTable.findFirst({
    where: eq(emailMessagesTable.id, messageId),
    with: {
      sender: true,
      recipients: {
        with: {
          address: true,
        },
      },
    },
  })
  if (!message) throw new Error('Message not found')
  return message
}

/**
 * Gets an email message by IMAP ID with sender and recipients
 */
export const getEmailMessageByImapId = async (imapId: string) => {
  const db = DatabaseSingleton.instance.db
  const message = await db.query.emailMessagesTable.findFirst({
    where: eq(emailMessagesTable.imapId, imapId),
    with: {
      sender: true,
      recipients: {
        with: {
          address: true,
        },
      },
    },
  })
  if (!message) throw new Error('Message not found')
  return message
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
