import type { PowerSyncTableName } from '@shared/powersync-tables'
import {
  type AnyPgColumn,
  type AnyPgTable,
  boolean,
  index,
  integer,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { getTableColumns } from 'drizzle-orm'
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
    agentId: text('agent_id'),
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
    chatThreadId: text('chat_thread_id'),
    modelId: text('model_id'),
    parentId: text('parent_id'),
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

export const modelProfilesTable = powersyncSchema.table(
  'model_profiles',
  {
    id: text('id').notNull(),
    temperature: real('temperature'),
    maxSteps: integer('max_steps'),
    maxAttempts: integer('max_attempts'),
    nudgeThreshold: integer('nudge_threshold'),
    useSystemMessageModeDeveloper: integer('use_system_message_mode_developer').default(0),
    toolsOverride: text('tools_override'),
    linkPreviewsOverride: text('link_previews_override'),
    chatModeAddendum: text('chat_mode_addendum'),
    searchModeAddendum: text('search_mode_addendum'),
    researchModeAddendum: text('research_mode_addendum'),
    citationReinforcementEnabled: integer('citation_reinforcement_enabled').default(0),
    citationReinforcementPrompt: text('citation_reinforcement_prompt'),
    nudgeFinalStep: text('nudge_final_step'),
    nudgePreventive: text('nudge_preventive'),
    nudgeRetry: text('nudge_retry'),
    nudgeSearchFinalStep: text('nudge_search_final_step'),
    nudgeSearchPreventive: text('nudge_search_preventive'),
    nudgeSearchRetry: text('nudge_search_retry'),
    providerOptions: text('provider_options'),
    defaultHash: text('default_hash'),
    deletedAt: timestamp('deleted_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.id, table.userId] }), index('idx_model_profiles_user_id').on(table.userId)],
)

/** Synced via PowerSync. Device list, status, and public key for encryption. */
export const devicesTable = powersyncSchema.table(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name'),
    trusted: boolean('trusted').notNull().default(false),
    approvalPending: boolean('approval_pending').notNull().default(false),
    publicKey: text('public_key'),
    mlkemPublicKey: text('mlkem_public_key'),
    lastSeen: timestamp('last_seen').defaultNow(),
    createdAt: timestamp('created_at').defaultNow(),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => [index('idx_devices_user_id').on(table.userId)],
)

export const agentsTable = powersyncSchema.table(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    type: text('type'),
    transport: text('transport'),
    command: text('command'),
    args: text('args'),
    url: text('url'),
    authMethod: text('auth_method'),
    icon: text('icon'),
    isSystem: integer('is_system').default(0),
    enabled: integer('enabled').default(1),
    deletedAt: timestamp('deleted_at'),
    defaultHash: text('default_hash'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('idx_agents_user_id').on(table.userId)],
)

/**
 * Map of PowerSync table names to Drizzle tables for account delete.
 * Must have an entry for every PowerSyncTableName (type-checked).
 */
export const powersyncTablesByName = {
  settings: settingsTable,
  chat_threads: chatThreadsTable,
  chat_messages: chatMessagesTable,
  tasks: tasksTable,
  models: modelsTable,
  mcp_servers: mcpServersTable,
  prompts: promptsTable,
  triggers: triggersTable,
  modes: modesTable,
  model_profiles: modelProfilesTable,
  devices: devicesTable,
  agents: agentsTable,
} satisfies Record<PowerSyncTableName, AnyPgTable>

/**
 * For each PowerSync table, map DB column name (snake_case) to schema key (camelCase).
 * Used when applying PowerSync upload operations with Drizzle's type-safe API.
 */
export const powersyncDbNameToSchemaKey: Record<PowerSyncTableName, Record<string, string>> = Object.fromEntries(
  (Object.entries(powersyncTablesByName) as [PowerSyncTableName, AnyPgTable][]).map(([tableName, table]) => [
    tableName,
    Object.fromEntries(Object.entries(getTableColumns(table)).map(([schemaKey, col]) => [col.name, schemaKey])),
  ]),
) as Record<PowerSyncTableName, Record<string, string>>

/**
 * Primary key column for each PowerSync table (for PATCH/DELETE where clauses).
 */
export const powersyncPkColumn: Record<PowerSyncTableName, AnyPgColumn> = {
  settings: settingsTable.key,
  chat_threads: chatThreadsTable.id,
  chat_messages: chatMessagesTable.id,
  tasks: tasksTable.id,
  models: modelsTable.id,
  mcp_servers: mcpServersTable.id,
  prompts: promptsTable.id,
  triggers: triggersTable.id,
  modes: modesTable.id,
  model_profiles: modelProfilesTable.id,
  devices: devicesTable.id,
  agents: agentsTable.id,
}

/**
 * Conflict target for each PowerSync table (for INSERT ON CONFLICT).
 * Tables with default data (settings, models, modes, tasks, prompts) use composite primary keys (id/key + user_id)
 * so each user can have their own row with the same default ID. See docs/composite-primary-keys-and-default-data.md.
 */
export const powersyncConflictTarget: Record<PowerSyncTableName, AnyPgColumn[]> = {
  settings: [settingsTable.key, settingsTable.userId],
  chat_threads: [chatThreadsTable.id],
  chat_messages: [chatMessagesTable.id],
  tasks: [tasksTable.id, tasksTable.userId],
  models: [modelsTable.id, modelsTable.userId],
  mcp_servers: [mcpServersTable.id],
  prompts: [promptsTable.id, promptsTable.userId],
  triggers: [triggersTable.id],
  modes: [modesTable.id, modesTable.userId],
  model_profiles: [modelProfilesTable.id, modelProfilesTable.userId],
  devices: [devicesTable.id],
  agents: [agentsTable.id],
}
