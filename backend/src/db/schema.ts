import { integer, pgTable, text, varchar } from 'drizzle-orm/pg-core'

// Re-export Better Auth schema tables
export * from './auth-schema'

export const usersTable = pgTable('users', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  age: integer().notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
})

/**
 * Settings table for user preferences.
 * Synced from client via PowerSync.
 */
export const settingsTable = pgTable('settings', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  value: text('value'),
  updatedAt: integer('updated_at'),
  defaultHash: text('default_hash'),
  deletedAt: integer('deleted_at'),
})

/**
 * Chat threads table.
 * Synced from client via PowerSync.
 */
export const chatThreadsTable = pgTable('chat_threads', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  title: text('title'),
  isEncrypted: integer('is_encrypted').default(0).notNull(),
  triggeredBy: text('triggered_by'),
  wasTriggeredByAutomation: integer('was_triggered_by_automation').default(0).notNull(),
  contextSize: integer('context_size'),
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at'),
})

/**
 * Chat messages table.
 * Synced from client via PowerSync.
 */
export const chatMessagesTable = pgTable('chat_messages', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  content: text('content').notNull(),
  role: text('role').notNull(),
  parts: text('parts'), // JSON stored as text
  chatThreadId: text('chat_thread_id').notNull(),
  modelId: text('model_id'),
  parentId: text('parent_id'),
  cache: text('cache'), // JSON stored as text
  metadata: text('metadata'), // JSON stored as text
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at'),
})

/**
 * Tasks table.
 * Synced from client via PowerSync.
 */
export const tasksTable = pgTable('tasks', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  item: text('item').notNull(),
  order: integer('order').notNull().default(0),
  isComplete: integer('is_complete').notNull().default(0),
  defaultHash: text('default_hash'),
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at'),
})

/**
 * AI Models table.
 * Synced from client via PowerSync.
 */
export const modelsTable = pgTable('models', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
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
  defaultHash: text('default_hash'),
  vendor: text('vendor'),
  description: text('description'),
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at'),
})

/**
 * MCP Servers table.
 * Synced from client via PowerSync.
 */
export const mcpServersTable = pgTable('mcp_servers', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull().default('http'),
  url: text('url'),
  command: text('command'),
  args: text('args'),
  enabled: integer('enabled').default(1).notNull(),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at'),
})

/**
 * Prompts table (automations).
 * Synced from client via PowerSync.
 */
export const promptsTable = pgTable('prompts', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  title: text('title'),
  prompt: text('prompt').notNull(),
  modelId: text('model_id').notNull(),
  defaultHash: text('default_hash'),
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at'),
})

/**
 * Triggers table.
 * Synced from client via PowerSync.
 */
export const triggersTable = pgTable('triggers', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  triggerType: text('trigger_type').notNull(),
  triggerTime: text('trigger_time'),
  promptId: text('prompt_id').notNull(),
  isEnabled: integer('is_enabled').default(1).notNull(),
  updatedAt: integer('updated_at'),
  deletedAt: integer('deleted_at'),
})
