import type { LinkPreviewData } from '@/integrations/thunderbolt-pro/schemas'
import type { WeatherForecastData } from '@/lib/weather-forecast'
import type { UIMessage } from 'ai'
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
  parentId: text('parent_id').references((): any => chatMessagesTable.id, { onDelete: 'cascade' }),
  cache: text('cache', { mode: 'json' }).$type<
    Record<
      string,
      | LinkPreviewData // linkPreview/[url]
      | WeatherForecastData // weatherForecast/[location]/[region]/[country]
    >
  >(),
})

export const tasksTable = sqliteTable('tasks', {
  id: text('id').primaryKey().notNull().unique(),
  item: text('item').notNull(),
  order: integer('order').notNull().default(0),
  isComplete: integer('is_complete').notNull().default(0),
  defaultHash: text('default_hash'),
})

export const modelsTable = sqliteTable('models', {
  id: text('id').primaryKey().notNull().unique(),
  provider: text('provider', {
    enum: ['openai', 'custom', 'openrouter', 'thunderbolt', 'anthropic'],
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
  deletedAt: integer('deleted_at'),
  defaultHash: text('default_hash'),
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
  deletedAt: integer('deleted_at'),
  defaultHash: text('default_hash'),
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
