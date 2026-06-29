/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PowerSyncTableName } from '@shared/powersync-tables'
import { workspacePermissionKeys, workspacePermissionRoles } from '@shared/workspaces'
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
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { getTableColumns, sql } from 'drizzle-orm'
import { user } from './auth-schema'

/**
 * PowerSync tables - mirror of frontend SQLite schema.
 * These tables sync bidirectionally with the frontend via PowerSync.
 */

const powersyncSchema = pgSchema('powersync')

/**
 * Workspace entity. Every real user gets one personal workspace (`is_personal = true`)
 * created by the Better Auth post-create hook; shared workspaces are created later via
 * PowerSync upload from the FE (gated by `allowWorkspaceCreationBy*` flags).
 *
 * `owner_user_id` defines who a personal workspace belongs to (NOT an access-control
 * "owner" role — roles live in `workspace_memberships`). The partial unique index
 * enforces "one personal workspace per user".
 */
export const workspacesTable = powersyncSchema.table(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug'),
    icon: text('icon'),
    isPersonal: boolean('is_personal').notNull().default(false),
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_workspaces_personal_per_owner')
      .on(table.ownerUserId)
      .where(sql`${table.isPersonal} = true`),
    index('idx_workspaces_owner_user_id').on(table.ownerUserId),
    uniqueIndex('idx_workspaces_slug')
      .on(table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
  ],
)

/**
 * Workspace membership and role assignment. The natural key per spec §3.7 is
 * `(workspace_id, user_id)`; PowerSync requires a single `id` column for row tracking,
 * so the natural key is enforced as a unique constraint instead of a composite PK.
 *
 * Roles are `admin` | `member` only (Decision 9 — no `owner`). Last-admin protection
 * lives in the upload handler factory.
 *
 * `user_name` / `user_email` are denormalized from `auth.user` so the Members
 * page can render display info without a synced `users` table — PowerSync sync
 * rules can't follow a `user_id` foreign key across buckets. The upload handler
 * fills them at insert time; the Better Auth `after('updateUser')` hook keeps
 * them in step when a user later edits their name or email.
 */
export const workspaceMembershipsTable = powersyncSchema.table(
  'workspace_memberships',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    userName: text('user_name'),
    userEmail: text('user_email'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_workspace_memberships_workspace_user').on(table.workspaceId, table.userId),
    index('idx_workspace_memberships_user').on(table.userId),
    index('idx_workspace_memberships_workspace').on(table.workspaceId),
  ],
)

/**
 * Pending memberships: admin invites an email that doesn't yet have an account.
 * On signup, the Better Auth post-create hook promotes any matching rows into
 * `workspace_memberships` and deletes them here. Emails are stored normalized
 * (lower-cased + trimmed) to match the `before` hook's normalization of `user.email`.
 */
export const workspacePendingMembershipsTable = powersyncSchema.table(
  'workspace_pending_memberships',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_workspace_pending_memberships_workspace_email').on(table.workspaceId, table.email),
    index('idx_workspace_pending_memberships_email').on(table.email),
    index('idx_workspace_pending_memberships_workspace').on(table.workspaceId),
  ],
)

/**
 * Per-workspace permission policy (Decision 10). The enum lists every
 * configurable action the workspace exposes; the source of truth lives in
 * `shared/workspaces.ts` so FE/BE schemas + types stay in lockstep.
 */
export const workspacePermissionsTable = powersyncSchema.table(
  'workspace_permissions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key', { enum: [...workspacePermissionKeys] }).notNull(),
    requiredRole: text('required_role', { enum: [...workspacePermissionRoles] }).notNull(),
  },
  (table) => [
    uniqueIndex('idx_workspace_permissions_workspace_key').on(table.workspaceId, table.permissionKey),
    index('idx_workspace_permissions_workspace').on(table.workspaceId),
  ],
)

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
    acpSessionId: text('acp_session_id'),
    agentId: text('agent_id'),
    deletedAt: timestamp('deleted_at'),
    // User-private within a workspace — the row's author is the only valid reader,
    // so deleting the user cascades the row away (no other member can ever see it).
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('idx_chat_threads_user_id').on(table.userId),
    index('idx_chat_threads_workspace_id').on(table.workspaceId),
  ],
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('idx_chat_messages_user_id').on(table.userId),
    index('idx_chat_messages_workspace_id').on(table.workspaceId),
  ],
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
  },
  (table) => [
    // Composite PK on (id, workspace_id) lets default-data rows repeat across workspaces.
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index('idx_tasks_user_id').on(table.userId),
    index('idx_tasks_workspace_id').on(table.workspaceId),
  ],
)

export const modelsTable = powersyncSchema.table(
  'models',
  {
    id: text('id').notNull(),
    provider: text('provider', {
      enum: ['openai', 'custom', 'openrouter', 'thunderbolt', 'anthropic', 'tinfoil'],
    }),
    name: text('name'),
    model: text('model'),
    url: text('url'),
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
    apiKey: text('api_key'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['workspace', 'user'] })
      .notNull()
      .default('workspace'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index('idx_models_user_id').on(table.userId),
    index('idx_models_workspace_id').on(table.workspaceId),
  ],
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
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['workspace', 'user'] })
      .notNull()
      .default('workspace'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index('idx_prompts_user_id').on(table.userId),
    index('idx_prompts_workspace_id').on(table.workspaceId),
  ],
)

export const skillsTable = powersyncSchema.table(
  'skills',
  {
    id: text('id').notNull(),
    name: text('name'),
    description: text('description'),
    instruction: text('instruction'),
    enabled: integer('enabled').default(1),
    pinnedOrder: integer('pinned_order'),
    deletedAt: timestamp('deleted_at'),
    defaultHash: text('default_hash'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['workspace', 'user'] })
      .notNull()
      .default('workspace'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index('idx_skills_user_id').on(table.userId),
    index('idx_skills_workspace_id').on(table.workspaceId),
  ],
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
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['workspace', 'user'] })
      .notNull()
      .default('workspace'),
  },
  (table) => [index('idx_triggers_user_id').on(table.userId), index('idx_triggers_workspace_id').on(table.workspaceId)],
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
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['workspace', 'user'] })
      .notNull()
      .default('workspace'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index('idx_modes_user_id').on(table.userId),
    index('idx_modes_workspace_id').on(table.workspaceId),
  ],
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
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['workspace', 'user'] })
      .notNull()
      .default('workspace'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index('idx_model_profiles_user_id').on(table.userId),
    index('idx_model_profiles_workspace_id').on(table.workspaceId),
  ],
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
    appVersion: text('app_version'),
  },
  (table) => [index('idx_devices_user_id').on(table.userId)],
)

/**
 * Synced via PowerSync. User-created ACP agents only. System agents are not rows.
 * Workspace-scoped, shared with all members. External service connection
 * configs belong to a workspace, not a single user — the addendum predates
 * this table being added in THU-547.
 */
export const agentsTable = powersyncSchema.table(
  'agents',
  {
    id: text('id').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspacesTable.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['remote-acp', 'managed-acp'] }).notNull(),
    transport: text('transport', { enum: ['websocket'] }).notNull(),
    url: text('url').notNull(),
    description: text('description'),
    icon: text('icon'),
    enabled: integer('enabled').default(1).notNull(),
    deletedAt: timestamp('deleted_at'),
    scope: text('scope', { enum: ['workspace', 'user'] })
      .notNull()
      .default('workspace'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.workspaceId] }),
    index('idx_agents_user_id').on(table.userId),
    index('idx_agents_workspace_id').on(table.workspaceId),
  ],
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
  prompts: promptsTable,
  skills: skillsTable,
  triggers: triggersTable,
  modes: modesTable,
  model_profiles: modelProfilesTable,
  devices: devicesTable,
  agents: agentsTable,
  workspaces: workspacesTable,
  workspace_memberships: workspaceMembershipsTable,
  workspace_pending_memberships: workspacePendingMembershipsTable,
  workspace_permissions: workspacePermissionsTable,
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
  prompts: promptsTable.id,
  skills: skillsTable.id,
  triggers: triggersTable.id,
  modes: modesTable.id,
  model_profiles: modelProfilesTable.id,
  devices: devicesTable.id,
  agents: agentsTable.id,
  workspaces: workspacesTable.id,
  workspace_memberships: workspaceMembershipsTable.id,
  workspace_pending_memberships: workspacePendingMembershipsTable.id,
  workspace_permissions: workspacePermissionsTable.id,
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
  tasks: [tasksTable.id, tasksTable.workspaceId],
  models: [modelsTable.id, modelsTable.workspaceId],
  prompts: [promptsTable.id, promptsTable.workspaceId],
  skills: [skillsTable.id, skillsTable.workspaceId],
  triggers: [triggersTable.id],
  modes: [modesTable.id, modesTable.workspaceId],
  model_profiles: [modelProfilesTable.id, modelProfilesTable.workspaceId],
  devices: [devicesTable.id],
  agents: [agentsTable.id, agentsTable.workspaceId],
  workspaces: [workspacesTable.id],
  workspace_memberships: [workspaceMembershipsTable.id],
  workspace_pending_memberships: [workspacePendingMembershipsTable.id],
  workspace_permissions: [workspacePermissionsTable.id],
}
