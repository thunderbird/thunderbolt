/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WidgetCacheData } from '@/widgets'
import type { UIMessage } from 'ai'
import type { UIMessageMetadata } from '@/types'
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { workspacePermissionKeys, workspacePermissionRoles } from '../../shared/workspaces'

export const settingsTable = sqliteTable('settings', {
  // Column is named 'id' in DB for PowerSync compatibility, but accessed as 'key' in TypeScript
  key: text('id').primaryKey(),
  value: text('value'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  defaultHash: text('default_hash'),
  userId: text('user_id'),
})

export const chatThreadsTable = sqliteTable(
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
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_chat_threads_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_chat_threads_workspace_id').on(table.workspaceId),
  ],
)

export const chatMessagesTable = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    content: text('content'),
    role: text('role').$type<UIMessage['role']>(),
    parts: text('parts', { mode: 'json' }).$type<UIMessage['parts']>(),
    chatThreadId: text('chat_thread_id'),
    modelId: text('model_id'),
    parentId: text('parent_id'),
    cache: text('cache', { mode: 'json' }).$type<Record<string, WidgetCacheData>>(),
    metadata: text('metadata', { mode: 'json' }).$type<UIMessageMetadata>(),
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_chat_messages_active')
      .on(table.chatThreadId)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_chat_messages_workspace_id').on(table.workspaceId),
  ],
)

export const tasksTable = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    item: text('item'),
    order: integer('order').default(0),
    isComplete: integer('is_complete').default(0),
    defaultHash: text('default_hash'),
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_tasks_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_tasks_workspace_id').on(table.workspaceId),
  ],
)

export const modelsTable = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
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
    deletedAt: text('deleted_at'),
    defaultHash: text('default_hash'),
    vendor: text('vendor'),
    description: text('description'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_models_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_models_workspace_id').on(table.workspaceId),
  ],
)

/** Local-only table for model API keys. Never synced via PowerSync. */
export const modelsSecretsTable = sqliteTable('models_secrets', {
  modelId: text('id').primaryKey(),
  apiKey: text('api_key'),
})

/** Local-only table for integration credentials (Google, Microsoft OAuth tokens). Never synced via PowerSync. */
export const integrationsSecretsTable = sqliteTable('integrations_secrets', {
  provider: text('id').primaryKey(), // 'google' | 'microsoft'
  credentials: text('credentials'), // JSON blob (OAuth tokens)
  enabled: integer('enabled').default(0),
})

/** Local-only table for MCP server credentials (bearer tokens / API keys). Never synced via PowerSync. */
export const mcpSecretsTable = sqliteTable('mcp_secrets', {
  id: text('id').primaryKey(), // = mcp_servers.id
  credentials: text('credentials'), // JSON blob (e.g. { type: 'bearer', token })
})

export const mcpServersTable = sqliteTable(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    type: text('type', { enum: ['http', 'sse', 'stdio'] }).default('http'),
    url: text('url'),
    command: text('command'),
    args: text('args'),
    enabled: integer('enabled').default(1),
    createdAt: text('created_at').default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`),
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_mcp_servers_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_mcp_servers_workspace_id').on(table.workspaceId),
  ],
)

export const promptsTable = sqliteTable(
  'prompts',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    prompt: text('prompt'),
    modelId: text('model_id'),
    deletedAt: text('deleted_at'),
    defaultHash: text('default_hash'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_prompts_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_prompts_workspace_id').on(table.workspaceId),
  ],
)

export const skillsTable = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    description: text('description'),
    instruction: text('instruction'),
    enabled: integer('enabled').default(1),
    pinnedOrder: integer('pinned_order'),
    deletedAt: text('deleted_at'),
    defaultHash: text('default_hash'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_skills_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_skills_workspace_id').on(table.workspaceId),
  ],
)

export const triggersTable = sqliteTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    triggerType: text('trigger_type', { enum: ['time'] }),
    triggerTime: text('trigger_time'),
    promptId: text('prompt_id'),
    isEnabled: integer('is_enabled').default(1),
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_triggers_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_triggers_workspace_id').on(table.workspaceId),
  ],
)

export const modelProfilesTable = sqliteTable(
  'model_profiles',
  {
    // PowerSync requires 'id' as the PK column name in the DB.
    // Drizzle field name is 'modelId' for TypeScript access.
    modelId: text('id').primaryKey(),
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
    providerOptions: text('provider_options', { mode: 'json' }).$type<Record<string, unknown>>(),
    defaultHash: text('default_hash'),
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_model_profiles_active')
      .on(table.modelId)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_model_profiles_workspace_id').on(table.workspaceId),
  ],
)

export const modesTable = sqliteTable(
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
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_modes_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_modes_workspace_id').on(table.workspaceId),
  ],
)

/** Synced via PowerSync. No token. Used for device list and revoke access. */
export const devicesTable = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  name: text('name'),
  trusted: integer('trusted'),
  approvalPending: integer('approval_pending'),
  publicKey: text('public_key'),
  mlkemPublicKey: text('mlkem_public_key'),
  lastSeen: text('last_seen'),
  createdAt: text('created_at'),
  revokedAt: text('revoked_at'),
})

/** Synced via PowerSync. User-created ACP agents only. `isSystem` is always 0; built-ins and system agents are not rows. */
export const agentsTable = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type', { enum: ['remote-acp', 'managed-acp'] }).notNull(),
    transport: text('transport', { enum: ['websocket'] }).notNull(),
    url: text('url').notNull(),
    description: text('description'),
    icon: text('icon'),
    enabled: integer('enabled').default(1).notNull(),
    deletedAt: text('deleted_at'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (table) => [
    index('idx_agents_active')
      .on(table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index('idx_agents_workspace_id').on(table.workspaceId),
  ],
)

/** Local-only table for system-provided ACP agents (e.g. Haystack), hydrated from backend `/agents` discovery. */
export const agentsSystemTable = sqliteTable('agents_system', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['managed-acp'] }).notNull(),
  transport: text('transport', { enum: ['websocket'] }).notNull(),
  url: text('url').notNull(),
  description: text('description'),
  icon: text('icon'),
  fetchedAt: text('fetched_at').notNull(),
})

/** Local-only table for ACP agent credentials (synced or system). Never leaves the device. */
export const agentsSecretsTable = sqliteTable('agents_secrets', {
  agentId: text('id').primaryKey(),
  apiKey: text('api_key'),
  authMethod: text('auth_method'),
})

/**
 * Workspace entity (synced via PowerSync). Personal workspace is BE-created for real
 * users by the Better Auth post-create hook; shared workspaces are FE-created via
 * PowerSync upload (commits in later PRs).
 */
export const workspacesTable = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug'),
  icon: text('icon'),
  isPersonal: integer('is_personal').notNull().default(0),
  ownerUserId: text('owner_user_id'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
})

/**
 * Workspace membership and role assignment. Natural key `(workspace_id, user_id)`
 * lives as a unique constraint on the BE; the FE keeps a single `id` PK to match
 * PowerSync's row-tracking convention.
 */
export const workspaceMembershipsTable = sqliteTable(
  'workspace_memberships',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id'),
    userId: text('user_id').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    // Denormalized display info written by the BE upload handler from `auth.user`.
    // Synced down so the Members page can render names + emails without a `users`
    // projection table (PowerSync sync rules can't follow `user_id` across buckets).
    userName: text('user_name'),
    userEmail: text('user_email'),
    createdAt: text('created_at'),
  },
  (table) => [index('idx_workspace_memberships_workspace_user').on(table.workspaceId, table.userId)],
)

/**
 * Pending direct-add for users without an account yet. Synced down only to admins
 * of the target workspace (via sync rules in commit 3). Backend promotes matching
 * rows into `workspace_memberships` when the email signs up.
 */
export const workspacePendingMembershipsTable = sqliteTable(
  'workspace_pending_memberships',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id'),
    email: text('email').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    invitedByUserId: text('invited_by_user_id').notNull(),
    createdAt: text('created_at'),
  },
  (table) => [index('idx_workspace_pending_memberships_workspace_email').on(table.workspaceId, table.email)],
)

/**
 * Per-workspace permission policy (Decision 10). The enum lists every
 * configurable action exposed by the Permissions page; the source of truth
 * lives in `shared/workspaces.ts` so FE/BE schemas + types stay in lockstep.
 */
export const workspacePermissionsTable = sqliteTable(
  'workspace_permissions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id'),
    permissionKey: text('permission_key', { enum: [...workspacePermissionKeys] }).notNull(),
    requiredRole: text('required_role', { enum: [...workspacePermissionRoles] }).notNull(),
  },
  (table) => [index('idx_workspace_permissions_workspace_key').on(table.workspaceId, table.permissionKey)],
)
