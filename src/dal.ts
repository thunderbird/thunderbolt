import { getDefaultCloudUrl } from '@/lib/config'
import { desc, eq, notExists } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseSingleton } from './db/singleton'
import { accountsTable, chatMessagesTable, chatThreadsTable, emailMessagesTable, emailThreadsTable, mcpServersTable, modelsTable, settingsTable } from './db/tables'
import { EmailThreadWithMessagesAndAddresses, type Model } from './types'

export const seedAccounts = async () => {
  const db = DatabaseSingleton.instance.db
  await db.select().from(accountsTable)
  // if (accounts.length === 0) {
  //   await db.insert(accountsTable).values({
  //     id: uuidv7(),
  //     type: 'imap',
  //     imapHostname: 'imap.thundermail.com',
  //     imapPort: 993,
  //     imapUsername: 'you@tb.pro',
  //     imapPassword: 'password',
  //   })
  // }
}

export const seedModels = async () => {
  const db = DatabaseSingleton.instance.db
  const models = await db.select().from(modelsTable)
  if (models.length === 0) {
    const seedData = [
      {
        id: uuidv7(),
        name: 'Llama 3.1 405B',
        provider: 'thunderbolt' as const,
        model: 'llama-v3p1-405b-instruct',
        isSystem: 1,
        enabled: 1,
        isConfidential: 0,
      },
      {
        id: uuidv7(),
        name: 'Llama 3.1 70B',
        provider: 'thunderbolt' as const,
        model: 'llama-v3p1-70b-instruct',
        isSystem: 1,
        enabled: 1,
        isConfidential: 0,
      },
      {
        id: uuidv7(),
        name: 'Qwen 3 235B',
        provider: 'thunderbolt' as const,
        model: 'qwen3-235b-a22b',
        isSystem: 0,
        enabled: 1,
        isConfidential: 0,
      },
      // {
      //   id: uuidv7(),
      //   name: 'DeepSeek R1 671B',
      //   provider: 'thunderbolt' as const,
      //   model: 'deepseek-r1-0528',
      //   isSystem: 0,
      //   enabled: 1,
      // },
      {
        id: uuidv7(),
        name: 'Llama 3.2 3B',
        provider: 'openai_compatible' as const,
        model: 'llama3.2:3b-instruct-q4_1',
        url: 'http://localhost:11434/v1',
        isSystem: 0,
        enabled: 1,
        isConfidential: 0,
      },
      // Confidential Compute model
      {
        id: uuidv7(),
        name: 'Mistral Small 24B (Confidential)',
        provider: 'flower' as const,
        model: 'mistralai/mistral-small-3.1-24b',
        isSystem: 0,
        enabled: 1,
        toolUsage: 1,
        isConfidential: 1,
      },
    ]
    for (const model of seedData) {
      await db.insert(modelsTable).values(model)
    }
  }
}

export const seedSettings = async () => {
  const db = DatabaseSingleton.instance.db
  await db
    .insert(settingsTable)
    .values({
      key: 'cloud_url',
      value: getDefaultCloudUrl(),
    })
    .onConflictDoNothing()

  await db
    .insert(settingsTable)
    .values({
      key: 'anonymous_id',
      value: uuidv7(), // @todo this should really be cryptographically secure
    })
    .onConflictDoNothing()
}

export const seedMcpServers = async () => {
  const db = DatabaseSingleton.instance.db
  const existingServers = await db.select().from(mcpServersTable).limit(1)

  if (existingServers.length === 0) {
    // Use centralized config for default MCP server URL
    await db.insert(mcpServersTable).values({
      id: uuidv7(),
      name: 'Thunderbolt MCP Server',
      url: `${getDefaultCloudUrl()}/mcp/`,
      enabled: 1,
    })
  }
}
/**
 * Gets the currently selected model or falls back to the system default model
 * @returns The selected model or system default model
 * @throws Error if no system model is found
 */
export const getSelectedModel = async (): Promise<Model> => {
  const db = DatabaseSingleton.instance.db
  const model = await db
    .select()
    .from(modelsTable)
    .where(eq(modelsTable.id, db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, 'selected_model'))))
    .get()

  if (model?.id) {
    return model
  }

  const systemModel = await db.select().from(modelsTable).where(eq(modelsTable.isSystem, 1)).get()

  if (!systemModel) {
    throw new Error('No system model found')
  }

  return systemModel
}

/**
 * Gets an existing empty chat thread or creates a new one
 * @returns The ID of the chat thread to use
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
    .where(notExists(db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, chatThreadsTable.id))))
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

export const getEmailThreadByIdWithMessages = async (emailThreadId: string): Promise<EmailThreadWithMessagesAndAddresses | null> => {
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

export const getEmailThreadByMessageImapIdWithMessages = async (imapId: string): Promise<EmailThreadWithMessagesAndAddresses | null> => {
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

export const getEmailThreadByMessageIdWithMessages = async (emailMessageId: string): Promise<EmailThreadWithMessagesAndAddresses | null> => {
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
