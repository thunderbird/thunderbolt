import { index, integer, pgTable, text } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * PowerSync tables - mirror of frontend SQLite schema.
 * These tables sync bidirectionally with the frontend via PowerSync.
 */

export const settingsTable = pgTable('settings', {
  // Column is named 'id' in DB for PowerSync compatibility, but accessed as 'key' in TypeScript
  key: text('id').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at').default(sql`extract(epoch from now())::integer`),
  defaultHash: text('default_hash'),
  userId: text('user_id'),
})

export const chatThreadsTable = pgTable(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    isEncrypted: integer('is_encrypted').default(0),
    triggeredBy: text('triggered_by'),
    wasTriggeredByAutomation: integer('was_triggered_by_automation').default(0),
    contextSize: integer('context_size'),
    deletedAt: integer('deleted_at'),
    userId: text('user_id'),
  },
  (table) => [
    index('idx_chat_threads_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

export const chatMessagesTable = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    content: text('content'),
    role: text('role'),
    parts: text('parts'),
    chatThreadId: text('chat_thread_id'),
    modelId: text('model_id'),
    parentId: text('parent_id'),
    cache: text('cache'),
    metadata: text('metadata'),
    deletedAt: integer('deleted_at'),
    userId: text('user_id'),
  },
  (table) => [
    index('idx_chat_messages_active')
      .on(table.chatThreadId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

export const tasksTable = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    item: text('item'),
    order: integer('order').default(0),
    isComplete: integer('is_complete').default(0),
    defaultHash: text('default_hash'),
    deletedAt: integer('deleted_at'),
    userId: text('user_id'),
  },
  (table) => [
    index('idx_tasks_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

export const modelsTable = pgTable(
  'models',
  {
    id: text('id').primaryKey(),
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
    userId: text('user_id'),
  },
  (table) => [
    index('idx_models_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

export const mcpServersTable = pgTable(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    type: text('type', { enum: ['http', 'stdio'] }).default('http'),
    url: text('url'),
    command: text('command'),
    args: text('args'),
    enabled: integer('enabled').default(1),
    createdAt: integer('created_at').default(sql`extract(epoch from now())::integer`),
    updatedAt: integer('updated_at').default(sql`extract(epoch from now())::integer`),
    deletedAt: integer('deleted_at'),
    userId: text('user_id'),
  },
  (table) => [
    index('idx_mcp_servers_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

export const promptsTable = pgTable(
  'prompts',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    prompt: text('prompt'),
    modelId: text('model_id'),
    deletedAt: integer('deleted_at'),
    defaultHash: text('default_hash'),
    userId: text('user_id'),
  },
  (table) => [
    index('idx_prompts_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

export const triggersTable = pgTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    triggerType: text('trigger_type', { enum: ['time'] }),
    triggerTime: text('trigger_time'),
    promptId: text('prompt_id'),
    isEnabled: integer('is_enabled').default(1),
    deletedAt: integer('deleted_at'),
    userId: text('user_id'),
  },
  (table) => [
    index('idx_triggers_active')
      .on(table.promptId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

export const modesTable = pgTable(
  'modes',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    label: text('label'),
    icon: text('icon'),
    systemPrompt: text('system_prompt'),
    isDefault: integer('is_default').default(0),
    order: integer('order').default(0),
    defaultHash: text('default_hash'),
    deletedAt: integer('deleted_at'),
    userId: text('user_id'),
  },
  (table) => [
    index('idx_modes_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)
