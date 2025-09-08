import type { ParsedEmail } from '@/types'
import type { UIMessage } from 'ai'
import { sql } from 'drizzle-orm'
import { customType, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const float32Array = customType<{
  data: number[]
  config: { dimensions: number }
  configRequired: true
  driverData: Buffer
}>({
  dataType(config) {
    return `F32_BLOB(${config.dimensions})`
  },
  fromDriver(value: Buffer) {
    return Array.from(new Float32Array(value.buffer))
  },
  toDriver(value: number[]) {
    return sql`vector32(${JSON.stringify(value)})`
  },
})

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
})

export const chatThreadsTable = sqliteTable('chat_threads', {
  id: text('id').primaryKey().notNull().unique(),
  title: text('title'),
  isEncrypted: integer('is_encrypted').default(0).notNull(),
  triggeredBy: text('triggered_by').references(() => promptsTable.id, { onDelete: 'set null' }),
  wasTriggeredByAutomation: integer('was_triggered_by_automation').default(0).notNull(),
  contextSize: integer('context_size'),
})

export const chatMessagesTable = sqliteTable('chat_messages', {
  id: text('id').primaryKey().notNull().unique(),
  content: text('content').notNull(),
  role: text('role').notNull().$type<UIMessage['role']>(),
  parts: text('parts', { mode: 'json' }).$type<UIMessage['parts']>(),
  chatThreadId: text('chat_thread_id')
    .notNull()
    .references(() => chatThreadsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  modelId: text('model_id').references(() => modelsTable.id),
})

export const contactsTable = sqliteTable('contacts', {
  id: text('id').primaryKey().notNull().unique(),
  name: text('name').notNull(),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
})

export const emailAddressesTable = sqliteTable('email_addresses', {
  address: text().primaryKey().notNull(),
  name: text('name'),
  contactId: text('contact_id').references(() => contactsTable.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
})

export const emailThreadsTable = sqliteTable('email_threads', {
  id: text('id').primaryKey().notNull().unique(),
  subject: text('subject').notNull(),
  rootImapId: text('root_imap_id'),
  firstMessageAt: integer('first_message_at').notNull(),
  lastMessageAt: integer('last_message_at').notNull(),
})

export const emailMessagesTable = sqliteTable('email_messages', {
  id: text('id').primaryKey().notNull().unique(),
  imapId: text('imap_id').notNull().unique(),
  htmlBody: text('html_body').notNull(),
  textBody: text('text_body').notNull(),
  parts: text('parts', { mode: 'json' }).$type<ParsedEmail>(),
  subject: text('subject'),
  sentAt: integer('sent_at').notNull(),
  fromAddress: text('from_address')
    .notNull()
    .references(() => emailAddressesTable.address, { onDelete: 'restrict', onUpdate: 'cascade' }),
  emailThreadId: text('email_thread_id')
    .notNull()
    .references(() => emailThreadsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  mailbox: text('mailbox').notNull(),
  references: text('references', { mode: 'json' }).$type<string[]>(),
})

export const tasksTable = sqliteTable('tasks', {
  id: text('id').primaryKey().notNull().unique(),
  item: text('item').notNull(),
  emailMessageId: text('email_message_id')
    .unique()
    .references(() => emailMessagesTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  order: integer('order').notNull().default(0),
  isComplete: integer('is_complete').notNull().default(0),
})

export const modelsTable = sqliteTable('models', {
  id: text('id').primaryKey().notNull().unique(),
  provider: text('provider', {
    enum: ['openai', 'custom', 'openrouter', 'thunderbolt', 'flower'],
  }).notNull(),
  name: text('name').notNull(),
  model: text('model').notNull(),
  url: text('url'),
  apiKey: text('api_key'),
  isSystem: integer('is_system').default(0),
  enabled: integer('enabled').default(1).notNull(),
  toolUsage: integer('tool_usage').default(1).notNull(),
  isConfidential: integer('is_confidential').default(0).notNull(),
  startWithReasoning: integer('start_with_reasoning').default(0).notNull(),
  contextWindow: integer('context_window'),
})

export const embeddingsTable = sqliteTable('embeddings', {
  id: text('id').primaryKey().notNull().unique(),
  emailMessageId: text('email_message_id')
    .unique()
    .references(() => emailMessagesTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  emailThreadId: text('email_thread_id')
    .unique()
    .references(() => emailThreadsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  embedding: float32Array('embedding', { dimensions: 384 }),
  asText: text('as_text'),
})

export const emailMessagesToAddressesTable = sqliteTable(
  'email_messages_to_addresses',
  {
    emailMessageId: text('email_message_id')
      .notNull()
      .references(() => emailMessagesTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    emailAddressId: text('email_address_id')
      .notNull()
      .references(() => emailAddressesTable.address, { onDelete: 'cascade', onUpdate: 'cascade' }),
    type: text('type', { enum: ['to', 'cc', 'bcc'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.emailMessageId, table.emailAddressId] })],
)

export const accountsTable = sqliteTable('accounts', {
  id: text('id').primaryKey().notNull().unique(),
  type: text('type', { enum: ['imap'] }).notNull(),
  imapHostname: text('imap_hostname'),
  imapPort: integer('imap_port'),
  imapUsername: text('imap_username'),
  imapPassword: text('imap_password'),
})

export const mcpServersTable = sqliteTable('mcp_servers', {
  id: text('id').primaryKey().notNull().unique(),
  name: text('name').notNull(),
  type: text('type', { enum: ['http', 'stdio'] })
    .notNull()
    .default('http'),
  url: text('url'),
  command: text('command'),
  args: text('args'),
  enabled: integer('enabled').default(1).notNull(),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
})

export const promptsTable = sqliteTable('prompts', {
  id: text('id').primaryKey().notNull().unique(),
  title: text('title'),
  prompt: text('prompt').notNull(),
  modelId: text('model_id')
    .notNull()
    .references(() => modelsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
})

export const triggersTable = sqliteTable('triggers', {
  id: text('id').primaryKey().notNull().unique(),
  triggerType: text('trigger_type', { enum: ['time'] }).notNull(),
  triggerTime: text('trigger_time'),
  promptId: text('prompt_id')
    .notNull()
    .references(() => promptsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  isEnabled: integer('is_enabled').default(1).notNull(),
})
