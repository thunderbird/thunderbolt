import { index, integer, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth-schema'

/**
 * PowerSync tables - mirror of frontend SQLite schema.
 * These tables sync bidirectionally with the frontend via PowerSync.
 */

const powersyncSchema = pgSchema('powersync')

export const settingsTable = powersyncSchema.table(
  'settings',
  {
    // Column is named 'id' in DB for PowerSync compatibility, but accessed as 'key' in TypeScript
    key: text('id').notNull(),
    value: text('value'),
    updatedAt: timestamp('updated_at').defaultNow(),
    defaultHash: text('default_hash'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.key, table.userId] }), index('idx_settings_user_id').on(table.userId)],
)

export const chatThreadsTable = powersyncSchema.table(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    isEncrypted: integer('is_encrypted').default(0),
    triggeredBy: text('triggered_by'),
    wasTriggeredByAutomation: integer('was_triggered_by_automation').default(0),
    contextSize: integer('context_size'),
    modeId: text('mode_id'),
    deletedAt: timestamp('deleted_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('idx_chat_threads_user_id').on(table.userId)],
)

export const chatMessagesTable = powersyncSchema.table(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    content: text('content'),
    role: text('role'),
    parts: text('parts'),
    chatThreadId: text('chat_thread_id').references(() => chatThreadsTable.id),
    modelId: text('model_id'),
    parentId: text('parent_id').references((): any => chatMessagesTable.id),
    cache: text('cache'),
    metadata: text('metadata'),
    deletedAt: timestamp('deleted_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('idx_chat_messages_user_id').on(table.userId)],
)

export const tasksTable = powersyncSchema.table(
  'tasks',
  {
    id: text('id').notNull(),
    item: text('item'),
    order: integer('order').default(0),
    isComplete: integer('is_complete').default(0),
    defaultHash: text('default_hash'),
    deletedAt: timestamp('deleted_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.id, table.userId] }), index('idx_tasks_user_id').on(table.userId)],
)

export const modelsTable = powersyncSchema.table(
  'models',
  {
    id: text('id').notNull(),
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
    deletedAt: timestamp('deleted_at'),
    defaultHash: text('default_hash'),
    vendor: text('vendor'),
    description: text('description'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.id, table.userId] }), index('idx_models_user_id').on(table.userId)],
)

export const mcpServersTable = powersyncSchema.table(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    type: text('type', { enum: ['http', 'stdio'] }).default('http'),
    url: text('url'),
    command: text('command'),
    args: text('args'),
    enabled: integer('enabled').default(1),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    deletedAt: timestamp('deleted_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('idx_mcp_servers_user_id').on(table.userId)],
)

export const promptsTable = powersyncSchema.table(
  'prompts',
  {
    id: text('id').notNull(),
    title: text('title'),
    prompt: text('prompt'),
    modelId: text('model_id'),
    deletedAt: timestamp('deleted_at'),
    defaultHash: text('default_hash'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.id, table.userId] }), index('idx_prompts_user_id').on(table.userId)],
)

export const triggersTable = powersyncSchema.table(
  'triggers',
  {
    id: text('id').primaryKey(),
    triggerType: text('trigger_type', { enum: ['time'] }),
    triggerTime: text('trigger_time'),
    promptId: text('prompt_id'),
    isEnabled: integer('is_enabled').default(1),
    deletedAt: timestamp('deleted_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('idx_triggers_user_id').on(table.userId)],
)

export const modesTable = powersyncSchema.table(
  'modes',
  {
    id: text('id').notNull(),
    name: text('name'),
    label: text('label'),
    icon: text('icon'),
    systemPrompt: text('system_prompt'),
    isDefault: integer('is_default').default(0),
    order: integer('order').default(0),
    defaultHash: text('default_hash'),
    deletedAt: timestamp('deleted_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.id, table.userId] }), index('idx_modes_user_id').on(table.userId)],
)

/** Synced via PowerSync. Device list and revoke access. No token. */
export const devicesTable = powersyncSchema.table(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name'),
    lastSeen: timestamp('last_seen').defaultNow(),
    createdAt: timestamp('created_at').defaultNow(),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => [index('idx_devices_user_id').on(table.userId)],
)
