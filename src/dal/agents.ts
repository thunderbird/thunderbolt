import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { agentsTable, settingsTable } from '../db/tables'
import { defaultAgentBuiltIn } from '../defaults/agents'
import { isAgentTypeEnabled } from '@/lib/enabled-agent-types'
import type { Agent, DrizzleQueryWithPromise } from '@/types'
import { v7 as uuidv7 } from 'uuid'

/**
 * Gets all agents (excluding soft-deleted).
 * System agents first, then alphabetically by name.
 */
export const getAllAgents = (db: AnyDrizzleDatabase) => {
  const query = db
    .select()
    .from(agentsTable)
    .where(isNull(agentsTable.deletedAt))
    .orderBy(desc(agentsTable.isSystem), agentsTable.name)

  return query as typeof query & DrizzleQueryWithPromise<Agent>
}

/**
 * Gets all enabled agents (excluding soft-deleted).
 * Returns hardcoded default if agents table is not available.
 */
export const getAvailableAgents = async (db: AnyDrizzleDatabase): Promise<Agent[]> => {
  try {
    const results = (await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.enabled, 1), isNull(agentsTable.deletedAt)))
      .orderBy(desc(agentsTable.isSystem), agentsTable.name)) as Agent[]
    return results.filter((a) => isAgentTypeEnabled(a.type))
  } catch (err) {
    console.warn('Failed to query agents table, using hardcoded default:', err)
    return isAgentTypeEnabled('built-in') ? [defaultAgentBuiltIn] : []
  }
}

/**
 * Gets a single agent by ID.
 */
export const getAgent = async (db: AnyDrizzleDatabase, id: string): Promise<Agent | undefined> => {
  const results = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, id), isNull(agentsTable.deletedAt)))

  return results[0] as Agent | undefined
}

/**
 * Gets the currently selected agent from settings, falling back to the built-in agent.
 * Falls back to the hardcoded default if the agents table hasn't been seeded yet
 * (e.g. when frontend deploys before backend migration).
 * Returns null if no usable agent can be resolved (e.g. all types disabled via VITE_ENABLED_AGENT_TYPES).
 */
export const getSelectedAgent = async (db: AnyDrizzleDatabase): Promise<Agent | null> => {
  try {
    const settings = await db.select().from(settingsTable).where(eq(settingsTable.key, 'selected_agent'))

    if (settings.length > 0 && settings[0].value) {
      const agent = await getAgent(db, settings[0].value)
      if (agent && isAgentTypeEnabled(agent.type)) {
        return agent
      }
    }

    // Fall back to built-in agent from DB
    if (isAgentTypeEnabled('built-in')) {
      const builtIn = await db
        .select()
        .from(agentsTable)
        .where(and(eq(agentsTable.type, 'built-in'), isNull(agentsTable.deletedAt)))

      if (builtIn.length > 0) {
        return builtIn[0] as Agent
      }
    }
  } catch (err) {
    console.warn('Failed to query agents table, using hardcoded default:', err)
  }

  // Hardcoded fallback — keeps the app functional even if agents table is missing
  return isAgentTypeEnabled('built-in') ? defaultAgentBuiltIn : null
}

// ── Registry agent management ─────────────────────────────────────────────────

type InstallRegistryAgentParams = {
  registryId: string
  name: string
  version: string
  distributionType: string
  installPath: string
  command: string
  args?: string[]
  description?: string
  packageName?: string
  icon?: string
}

/**
 * Installs a registry-managed agent into the database.
 * Uses a deterministic ID based on the registryId.
 * If the agent already exists (e.g. previously uninstalled via soft-delete),
 * it updates the record and clears deletedAt to re-enable it.
 *
 * Uses select-then-insert/update because PowerSync exposes views,
 * and SQLite cannot UPSERT into a view.
 */
export const installRegistryAgent = async (
  db: AnyDrizzleDatabase,
  params: InstallRegistryAgentParams,
): Promise<Agent> => {
  const id = `agent-registry-${params.registryId}`

  const existing = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()

  if (existing) {
    await db
      .update(agentsTable)
      .set({
        name: params.name,
        type: 'local',
        transport: 'stdio',
        command: params.command,
        args: params.args ? JSON.stringify(params.args) : null,
        icon: params.icon ?? null,
        enabled: 1,
        registryId: params.registryId,
        installedVersion: params.version,
        registryVersion: params.version,
        distributionType: params.distributionType,
        installPath: params.installPath,
        packageName: params.packageName ?? null,
        description: params.description ?? null,
        deletedAt: null,
      })
      .where(eq(agentsTable.id, id))
  } else {
    await db.insert(agentsTable).values({
      id,
      name: params.name,
      type: 'local',
      transport: 'stdio',
      command: params.command,
      args: params.args ? JSON.stringify(params.args) : null,
      icon: params.icon ?? null,
      isSystem: 0,
      enabled: 1,
      registryId: params.registryId,
      installedVersion: params.version,
      registryVersion: params.version,
      distributionType: params.distributionType,
      installPath: params.installPath,
      packageName: params.packageName ?? null,
      description: params.description ?? null,
    })
  }

  const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
  return result as Agent
}

/**
 * Soft-deletes a registry agent from the database.
 * Returns true if the agent was found and marked deleted, false if it didn't exist.
 * installRegistryAgent handles the soft-deleted case on reinstall by clearing deletedAt.
 */
export const uninstallRegistryAgent = async (db: AnyDrizzleDatabase, id: string): Promise<boolean> => {
  const existing = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
  if (!existing) {
    return false
  }
  await db.update(agentsTable).set({ deletedAt: new Date().toISOString() }).where(eq(agentsTable.id, id))
  return true
}

/**
 * Toggles an agent's enabled state.
 * Returns the updated agent, or undefined if not found.
 */
export const toggleAgent = async (db: AnyDrizzleDatabase, id: string, enabled: boolean): Promise<Agent | undefined> => {
  await db
    .update(agentsTable)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(agentsTable.id, id))

  const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
  return result as Agent | undefined
}

/**
 * Gets all installed registry agents (where registryId is not null).
 * Excludes soft-deleted agents.
 */
export const getInstalledRegistryAgents = async (db: AnyDrizzleDatabase): Promise<Agent[]> => {
  const results = await db
    .select()
    .from(agentsTable)
    .where(and(isNotNull(agentsTable.registryId), isNull(agentsTable.deletedAt)))
    .orderBy(agentsTable.name)

  return results as Agent[]
}

type AddCustomAgentParams = {
  name: string
  command: string
  args?: string[]
  description?: string
  apiKey?: string
}

/**
 * Adds a custom (non-registry) local agent.
 */
export const addCustomAgent = async (db: AnyDrizzleDatabase, params: AddCustomAgentParams): Promise<Agent> => {
  const id = uuidv7()

  await db.insert(agentsTable).values({
    id,
    name: params.name,
    type: 'local',
    transport: 'stdio',
    command: params.command,
    args: params.args ? JSON.stringify(params.args) : null,
    isSystem: 0,
    enabled: 1,
    distributionType: 'custom',
    description: params.description ?? null,
    authMethod: params.apiKey ? JSON.stringify({ apiKey: params.apiKey }) : null,
  })

  const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
  return result as Agent
}

type AddRemoteAgentParams = {
  name: string
  url: string
  description?: string
  apiKey?: string
}

/**
 * Adds a custom remote agent (WebSocket).
 */
export const addRemoteAgent = async (db: AnyDrizzleDatabase, params: AddRemoteAgentParams): Promise<Agent> => {
  const id = uuidv7()

  await db.insert(agentsTable).values({
    id,
    name: params.name,
    type: 'remote',
    transport: 'websocket',
    url: params.url,
    isSystem: 0,
    enabled: 1,
    distributionType: 'remote',
    description: params.description ?? null,
    authMethod: params.apiKey ? JSON.stringify({ apiKey: params.apiKey }) : null,
  })

  const result = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).get()
  return result as Agent
}
