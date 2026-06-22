/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, isNull } from 'drizzle-orm'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { selectBuiltInAgentEnabled, useConfigStore } from '@/api/config-store'
import { disposeAdapter } from '@/acp/adapter-cache'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { agentsSecretsTable, agentsSystemTable, agentsTable } from '../db/tables'
import { builtInAgent } from '../defaults/agents'
import { nowIso } from '../lib/utils'
import { useActiveWorkspaceId } from '../lib/active-workspace'
import type { Agent } from '@/types/acp'

/** Shape persisted in the local-only `agents_secrets` table. */
export type AgentSecrets = {
  apiKey: string | null
  authMethod: string | null
}

/** Row shape returned by the synced `agents` table query. Columns mirror the
 *  table; `isSystem` is always 0 for custom agents — built-ins and system
 *  agents are NOT rows in this table. */
type AgentCustomRow = typeof agentsTable.$inferSelect
type AgentSystemRow = typeof agentsSystemTable.$inferSelect

/** Lift a synced custom row into the unified `Agent` shape used by UI/chat. */
const customRowToAgent = (row: AgentCustomRow): Agent => ({
  id: row.id,
  name: row.name,
  type: row.type,
  transport: row.transport,
  url: row.url,
  description: row.description,
  icon: row.icon,
  isSystem: 0,
  enabled: row.enabled === 1 ? 1 : 0,
  deletedAt: row.deletedAt,
  userId: row.userId,
  scope: row.scope,
})

/** Lift a local-only system row into the unified `Agent` shape. */
const systemRowToAgent = (row: AgentSystemRow): Agent => ({
  id: row.id,
  name: row.name,
  type: row.type,
  transport: row.transport,
  url: row.url,
  description: row.description,
  icon: row.icon,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
})

/** Query for all non-deleted custom agents in the given workspace (synced via PowerSync), alpha by name. */
export const getAllAgents = (db: AnyDrizzleDatabase, workspaceId: string) =>
  db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.workspaceId, workspaceId), isNull(agentsTable.deletedAt)))
    .orderBy(asc(agentsTable.name))

/** Query for all local-only system agents, alpha by name. Not workspace-scoped — `agents_system` is device-local. */
export const getAllSystemAgents = (db: AnyDrizzleDatabase) =>
  db.select().from(agentsSystemTable).orderBy(asc(agentsSystemTable.name))

/** Live hook for custom (synced) agents in the active workspace. Returns `Agent[]` in visual order. */
export const useAgents = (): Agent[] => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const { data = [] } = useQuery({
    queryKey: ['agents', workspaceId],
    query: toCompilableQuery(getAllAgents(db, workspaceId ?? '')),
    enabled: !!workspaceId,
  })
  return data.map(customRowToAgent)
}

/** Live hook for local-only system agents (hydrated by `refreshSystemAgents`). */
export const useSystemAgents = (): Agent[] => {
  const db = useDatabase()
  const { data = [] } = useQuery({
    queryKey: ['agents-system'],
    query: toCompilableQuery(getAllSystemAgents(db)),
  })
  return data.map(systemRowToAgent)
}

/** Visual-order composer: built-in first, then system (alpha), then customs (alpha).
 *  Extracted from `useAllAgents` so the ordering rule is unit-testable without
 *  spinning up PowerSync + React. The DB queries already return rows sorted
 *  alpha by name, so this just concatenates them in the canonical order.
 *
 *  `includeBuiltIn` defaults to true; deployments that ship only their own agents
 *  (server config `disableBuiltInAgent`) pass `false` to omit it entirely — it is
 *  dropped from the list, not merely disabled. */
export const composeAllAgents = (
  systemAgents: Agent[],
  customAgents: Agent[],
  options: { includeBuiltIn?: boolean } = {},
): Agent[] => [...(options.includeBuiltIn === false ? [] : [builtInAgent]), ...systemAgents, ...customAgents]

/** Combined list hook: built-in first (unless disabled by deployment), then
 *  system (alpha), then customs (alpha). Matches the Settings/Agents visual order. */
export const useAllAgents = (): Agent[] => {
  const includeBuiltIn = useConfigStore((state) => selectBuiltInAgentEnabled(state.config))
  return composeAllAgents(useSystemAgents(), useAgents(), { includeBuiltIn })
}

/** Fields accepted by `createAgent`. `id` is caller-generated (uuid). */
export type CreateAgentInput = {
  id: string
  name: string
  type: 'remote-acp' | 'managed-acp'
  transport: 'websocket'
  url: string
  description?: string | null
  icon?: string | null
  enabled?: 0 | 1
  userId: string
  /** Per-row visibility (THU-603). `'workspace'` (default) shares with all
   *  members; `'user'` keeps the agent private to its author. */
  scope?: 'workspace' | 'user'
}

/** Insert a new custom agent into the synced table in the given workspace.
 *  `userId` is required — synced tables must carry it from the caller's session. */
export const createAgent = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  data: CreateAgentInput,
): Promise<void> => {
  await db.insert(agentsTable).values({
    id: data.id,
    name: data.name,
    type: data.type,
    transport: data.transport,
    url: data.url,
    description: data.description ?? null,
    icon: data.icon ?? null,
    enabled: data.enabled ?? 1,
    userId: data.userId,
    workspaceId,
    scope: data.scope ?? 'workspace',
  })
}

/** Fields patchable via `updateAgent`. `id`/`userId`/`deletedAt` are managed
 *  internally — callers cannot rewrite them through this entry point. */
export type UpdateAgentPatch = Partial<
  Pick<CreateAgentInput, 'name' | 'type' | 'transport' | 'url' | 'description' | 'icon' | 'enabled'>
>

/** Patch fields whose change invalidates a warm ACP connection — the wire
 *  identity (endpoint + transport + agent type). Editing any of these means the
 *  next chat must reconnect, so the cached adapter is disposed. */
const connectionInvalidatingFields: ReadonlyArray<keyof UpdateAgentPatch> = ['url', 'transport', 'type']

/** Patch an existing custom agent. Built-in and system agents are not editable
 *  through the DAL — built-in lives in code, system rows live in the local-only
 *  `agents_system` table which `updateAgent` never touches.
 *
 *  Editing the wire identity (url/transport/type) disposes the agent's warm ACP
 *  connection so the next chat reconnects against the new endpoint. */
export const updateAgent = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  patch: UpdateAgentPatch,
): Promise<void> => {
  if (id === builtInAgent.id) {
    throw new Error(`updateAgent: refusing to edit built-in agent "${id}"`)
  }
  if (Object.keys(patch).length === 0) {
    return
  }
  await db
    .update(agentsTable)
    .set(patch)
    .where(and(eq(agentsTable.id, id), eq(agentsTable.workspaceId, workspaceId), isNull(agentsTable.deletedAt)))

  if (connectionInvalidatingFields.some((field) => field in patch)) {
    await disposeAdapter(id)
  }
}

/** Soft delete a custom agent in the given workspace. Never hard-delete — sets
 *  `deletedAt` and lets PowerSync replicate the tombstone. Built-ins/system rows
 *  are not in this table and cannot be removed. */
export const deleteAgent = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<void> => {
  if (id === builtInAgent.id) {
    throw new Error(`deleteAgent: refusing to delete built-in agent "${id}"`)
  }
  await db
    .update(agentsTable)
    .set({ deletedAt: nowIso() })
    .where(and(eq(agentsTable.id, id), eq(agentsTable.workspaceId, workspaceId), isNull(agentsTable.deletedAt)))

  await disposeAdapter(id)
}

/** Read credentials for an agent from the local-only secrets table.
 *  Returns `null` when no row exists for `id`. Not workspace-scoped — `agents_secrets` is device-local. */
export const getAgentSecrets = async (db: AnyDrizzleDatabase, id: string): Promise<AgentSecrets | null> => {
  const row = await db.select().from(agentsSecretsTable).where(eq(agentsSecretsTable.agentId, id)).get()
  if (!row) {
    return null
  }
  return { apiKey: row.apiKey, authMethod: row.authMethod }
}

/** Upsert credentials for an agent into the local-only secrets table.
 *
 *  PowerSync exposes local-only tables as SQLite views, which don't support
 *  `INSERT ... ON CONFLICT DO UPDATE`. Emulate UPSERT with SELECT-then-INSERT/UPDATE,
 *  same pattern as `models_secrets` / `integrations_secrets`. */
export const setAgentSecrets = async (
  db: AnyDrizzleDatabase,
  id: string,
  secrets: Partial<AgentSecrets>,
): Promise<void> => {
  const existing = await db.select().from(agentsSecretsTable).where(eq(agentsSecretsTable.agentId, id)).get()

  if (existing) {
    const patch: Partial<AgentSecrets> = {}
    if (secrets.apiKey !== undefined) {
      patch.apiKey = secrets.apiKey
    }
    if (secrets.authMethod !== undefined) {
      patch.authMethod = secrets.authMethod
    }
    if (Object.keys(patch).length === 0) {
      return
    }
    await db.update(agentsSecretsTable).set(patch).where(eq(agentsSecretsTable.agentId, id))
    return
  }

  await db.insert(agentsSecretsTable).values({
    agentId: id,
    apiKey: secrets.apiKey ?? null,
    authMethod: secrets.authMethod ?? null,
  })
}
