/**
 * Database schema for cr-sqlite CRRs (Conflict-free Replicated Relations)
 *
 * Important constraints for cr-sqlite compatibility:
 * 1. NO unique indices besides primary keys - CRRs can't have additional unique constraints
 * 2. NO checked foreign key constraints - data can arrive out of order during sync
 * 3. All NOT NULL columns must have DEFAULT values - for forwards/backwards compatibility
 *
 * Relationships are maintained logically via column names (e.g., chatThreadId -> chat_threads.id)
 * but are NOT enforced at the database level to enable CRDT-based sync.
 */

import type { WidgetCacheData } from '@/widgets'
import type { UIMessage } from 'ai'
import type { UIMessageMetadata } from '@/types'
import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
  defaultHash: text('default_hash'),
})

export const chatThreadsTable = sqliteTable('chat_threads', {
  id: text('id').primaryKey().notNull(),
  title: text('title'),
  isEncrypted: integer('is_encrypted').default(0).notNull(),
  triggeredBy: text('triggered_by'), // Logical FK to prompts.id
  wasTriggeredByAutomation: integer('was_triggered_by_automation').default(0).notNull(),
  contextSize: integer('context_size'),
})

export const chatMessagesTable = sqliteTable('chat_messages', {
  id: text('id').primaryKey().notNull(),
  content: text('content').notNull().default(''),
  role: text('role').notNull().default('user').$type<UIMessage['role']>(),
  parts: text('parts', { mode: 'json' }).$type<UIMessage['parts']>(),
  chatThreadId: text('chat_thread_id').notNull().default(''), // Logical FK to chat_threads.id
  modelId: text('model_id'), // Logical FK to models.id
  parentId: text('parent_id'), // Logical FK to chat_messages.id (self-reference)
  cache: text('cache', { mode: 'json' }).$type<Record<string, WidgetCacheData>>(),
  metadata: text('metadata', { mode: 'json' }).$type<UIMessageMetadata>(),
})

export const tasksTable = sqliteTable('tasks', {
  id: text('id').primaryKey().notNull(),
  item: text('item').notNull().default(''),
  order: integer('order').notNull().default(0),
  isComplete: integer('is_complete').notNull().default(0),
  defaultHash: text('default_hash'),
})

export const modelsTable = sqliteTable('models', {
  id: text('id').primaryKey().notNull(),
  provider: text('provider', {
    enum: ['openai', 'custom', 'openrouter', 'thunderbolt', 'anthropic'],
  })
    .notNull()
    .default('custom'),
  name: text('name').notNull().default(''),
  model: text('model').notNull().default(''),
  url: text('url'),
  apiKey: text('api_key'),
  isSystem: integer('is_system').default(0),
  enabled: integer('enabled').default(1).notNull(),
  toolUsage: integer('tool_usage').default(1).notNull(),
  isConfidential: integer('is_confidential').default(0).notNull(),
  startWithReasoning: integer('start_with_reasoning').default(0).notNull(),
  supportsParallelToolCalls: integer('supports_parallel_tool_calls').default(1).notNull(),
  contextWindow: integer('context_window'),
  deletedAt: integer('deleted_at'),
  defaultHash: text('default_hash'),
  vendor: text('vendor'),
  description: text('description'),
})

export const mcpServersTable = sqliteTable('mcp_servers', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull().default(''),
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
  id: text('id').primaryKey().notNull(),
  title: text('title'),
  prompt: text('prompt').notNull().default(''),
  modelId: text('model_id').notNull().default(''), // Logical FK to models.id
  deletedAt: integer('deleted_at'),
  defaultHash: text('default_hash'),
})

export const triggersTable = sqliteTable('triggers', {
  id: text('id').primaryKey().notNull(),
  triggerType: text('trigger_type', { enum: ['time'] })
    .notNull()
    .default('time'),
  triggerTime: text('trigger_time'),
  promptId: text('prompt_id').notNull().default(''), // Logical FK to prompts.id
  isEnabled: integer('is_enabled').default(1).notNull(),
})
