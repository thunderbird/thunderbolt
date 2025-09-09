import { and, asc, desc, eq, like, notExists, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
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
export const getModelById = async (id: string): Promise<Model | null> => {
  const db = DatabaseSingleton.instance.db
  const model = await db.select().from(modelsTable).where(eq(modelsTable.id, id)).get()
  return model ? mapModel(model) : null
}

/**
 * Gets the currently selected model or falls back to the system default model
 */
export const getSelectedModel = async (): Promise<Model> => {
  const db = DatabaseSingleton.instance.db
  const model = await db
    .select()
    .from(modelsTable)
    .where(
      eq(
        modelsTable.id,
        db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, 'selected_model')),
      ),
    )
    .get()

  if (model?.id) {
    return mapModel(model)
  }

  const systemModel = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1)).get()

  if (!systemModel) {
    throw new Error('No system model found')
  }

  return mapModel(systemModel)
}

/**
 * Gets the default model for a chat thread based on the last message in the thread, falling back to the selected_model setting.
 */
export const getDefaultModelForThread = async (threadId: string, fallbackModelId?: string): Promise<Model> => {
  const db = DatabaseSingleton.instance.db

  const lastMessage = await db
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

  if (lastMessage?.modelId) {
    const model = await getModelById(lastMessage.modelId)

    if (model) {
      return model
    }
  }

  if (fallbackModelId) {
    const model = await getModelById(fallbackModelId)

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
  const db = DatabaseSingleton.instance.db
  const nameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_name'))
  const latData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lat'))
  const lngData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'location_lng'))
  const preferredNameData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'preferred_name'))
  const dataCollection = await db.select().from(settingsTable).where(eq(settingsTable.key, 'data_collection'))
  const experimentalFeatureAutomations = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, 'experimental_feature_automations'))
  const experimentalFeatureTasks = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, 'experimental_feature_tasks'))

  return {
    locationName: nameData[0]?.value || '',
    locationLat: latData[0]?.value || '',
    locationLng: lngData[0]?.value || '',
    preferredName: preferredNameData[0]?.value || '',
    dataCollection: dataCollection[0]?.value === 'false' ? false : true,
    experimentalFeatureAutomations: experimentalFeatureAutomations[0]?.value === 'true' ? true : false,
    experimentalFeatureTasks: experimentalFeatureTasks[0]?.value === 'true' ? true : false,
  }
}

/**
 * Gets theme setting with proper typing
 */
export const getThemeSetting = async (storageKey: string, defaultTheme: string): Promise<string> => {
  const db = DatabaseSingleton.instance.db
  const result = await db.select().from(settingsTable).where(eq(settingsTable.key, storageKey))
  return (result[0]?.value as string) || defaultTheme
}

/**
 * Gets bridge settings with specific structure
 */
export const getBridgeSettings = async () => {
  const db = DatabaseSingleton.instance.db
  const enabledData = await db.select().from(settingsTable).where(eq(settingsTable.key, 'bridge_enabled'))
  return {
    enabled: enabledData[0]?.value === 'true',
  }
}

/**
 * Get a setting value from the settings table
 */
export const getSetting = async <T = string>(key: string, defaultValue: T | null = null): Promise<T | null> => {
  const db = DatabaseSingleton.instance.db
  const setting = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
  return (setting?.value as T) || defaultValue
}

/**
 * Get a boolean setting value from the settings table
 */
export const getBooleanSetting = async (key: string, defaultValue: boolean = false): Promise<boolean> => {
  const setting = await getSetting(key, defaultValue.toString())
  return setting === 'true'
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
export const getChatThreadById = async (id: string) => {
  const db = DatabaseSingleton.instance.db
  return await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()
}

/**
 * Gets an existing empty chat thread or creates a new one
 */
export const getOrCreateChatThread = async (isEncrypted: boolean = false): Promise<string> => {
  const db = DatabaseSingleton.instance.db
  // First check if any threads exist
  const threads = await db.select().from(chatThreadsTable).orderBy(desc(chatThreadsTable.id))

  if (threads.length === 0) {
    // No threads exist, create a new one
    const chatThreadId = uuidv7()
    await db.insert(chatThreadsTable).values({ id: chatThreadId, title: 'New Chat', isEncrypted: isEncrypted ? 1 : 0 })
    return chatThreadId
  }

  // Check for empty threads first
  const emptyThreads = await db
    .select({ id: chatThreadsTable.id })
    .from(chatThreadsTable)
    .where(
      notExists(db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, chatThreadsTable.id))),
    )
    .limit(1)

  if (emptyThreads.length > 0) {
    // Use the empty thread
    return emptyThreads[0].id
  }

  // No empty threads, create a new one
  const chatThreadId = uuidv7()
  await db.insert(chatThreadsTable).values({ id: chatThreadId, title: 'New Chat', isEncrypted: isEncrypted ? 1 : 0 })
  return chatThreadId
}

// ============================================================================
// CHAT MESSAGES
// ============================================================================

/**
 * Gets all chat messages for a specific thread
 */
export const getChatMessagesByThreadId = async (threadId: string) => {
  const db = DatabaseSingleton.instance.db
  const chatMessages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatThreadId, threadId))
    .orderBy(chatMessagesTable.id)
  return chatMessages
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
  const allServers = await db.select().from(mcpServersTable)
  return allServers
    .filter((server) => server.type === 'http' && server.url !== null)
    .map((server) => ({
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

export const getEmailThreadByIdWithMessages = async (
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
export const getEmailMessageById = async (messageId: string) => {
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
