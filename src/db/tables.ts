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
  id: text('id').primaryKey().notNull().unique(),
  title: text('title'),
  isEncrypted: integer('is_encrypted').default(0),
  triggeredBy: text('triggered_by').references(() => promptsTable.id, { onDelete: 'set null' }),
  wasTriggeredByAutomation: integer('was_triggered_by_automation').default(0),
  contextSize: integer('context_size'),
  deletedAt: integer('deleted_at'),
})

export const chatMessagesTable = sqliteTable('chat_messages', {
  id: text('id').primaryKey().notNull().unique(),
  content: text('content'),
  role: text('role').$type<UIMessage['role']>(),
  parts: text('parts', { mode: 'json' }).$type<UIMessage['parts']>(),
  chatThreadId: text('chat_thread_id')
    .notNull()
    .references(() => chatThreadsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  modelId: text('model_id').references(() => modelsTable.id),
  parentId: text('parent_id').references((): any => chatMessagesTable.id, { onDelete: 'cascade' }),
  cache: text('cache', { mode: 'json' }).$type<Record<string, WidgetCacheData>>(),
  metadata: text('metadata', { mode: 'json' }).$type<UIMessageMetadata>(),
  deletedAt: integer('deleted_at'),
})

export const tasksTable = sqliteTable('tasks', {
  id: text('id').primaryKey().notNull().unique(),
  item: text('item'),
  order: integer('order').default(0),
  isComplete: integer('is_complete').default(0),
  defaultHash: text('default_hash'),
  deletedAt: integer('deleted_at'),
})

export const modelsTable = sqliteTable('models', {
  id: text('id').primaryKey().notNull().unique(),
  provider: text('provider', {
    enum: ['openai', 'custom', 'openrouter', 'thunderbolt', 'anthropic'],
  }),
  name: text('name'),
  model: text('model'),
  url: text('url'),
  apiKey: text('api_key'),
  isSystem: integer('is_system').default(0),
  enabled: integer('enabled').default(1),
  toolUsage: integer('tool_usage').default(1),
  isConfidential: integer('is_confidential').default(0),
  startWithReasoning: integer('start_with_reasoning').default(0),
  supportsParallelToolCalls: integer('supports_parallel_tool_calls').default(1),
  contextWindow: integer('context_window'),
  deletedAt: integer('deleted_at'),
  defaultHash: text('default_hash'),
  vendor: text('vendor'),
  description: text('description'),
})

export const mcpServersTable = sqliteTable('mcp_servers', {
  id: text('id').primaryKey().notNull().unique(),
  name: text('name'),
  type: text('type', { enum: ['http', 'stdio'] }).default('http'),
  url: text('url'),
  command: text('command'),
  args: text('args'),
  enabled: integer('enabled').default(1),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`),
  deletedAt: integer('deleted_at'),
})

export const promptsTable = sqliteTable('prompts', {
  id: text('id').primaryKey().notNull().unique(),
  title: text('title'),
  prompt: text('prompt'),
  modelId: text('model_id')
    .notNull()
    .references(() => modelsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  deletedAt: integer('deleted_at'),
  defaultHash: text('default_hash'),
})

export const triggersTable = sqliteTable('triggers', {
  id: text('id').primaryKey().notNull().unique(),
  triggerType: text('trigger_type', { enum: ['time'] }),
  triggerTime: text('trigger_time'),
  promptId: text('prompt_id')
    .notNull()
    .references(() => promptsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  isEnabled: integer('is_enabled').default(1),
  deletedAt: integer('deleted_at'),
})
