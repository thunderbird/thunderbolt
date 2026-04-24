import { http, type HttpClient } from '@/lib/http'
import { isAgentTypeEnabled } from '@/lib/enabled-agent-types'
import { getAuthToken } from '@/lib/auth-token'
import { hashAgent } from '@/defaults/agents'
import { agentsTable } from '@/db/tables'
import { eq, inArray, isNotNull, isNull, and } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { Agent } from '@/types'
import type { RemoteAgentDescriptor } from '@shared/agent-types'
import type { RegistryEntry } from './registry'

/**
 * Upsert agents into the DB, inserting new ones and updating changed ones.
 * Compares by hash to avoid unnecessary writes.
 */
const upsertAgents = async (db: AnyDrizzleDatabase, agents: Agent[]): Promise<void> => {
  if (agents.length === 0) {
    return
  }

  const existingRows = await db
    .select()
    .from(agentsTable)
    .where(
      inArray(
        agentsTable.id,
        agents.map((a) => a.id),
      ),
    )
  const existingById = new Map(existingRows.map((r) => [r.id, r]))

  await Promise.all(
    agents.map((agent) => {
      const agentHash = hashAgent(agent)
      const existing = existingById.get(agent.id)

      if (!existing) {
        return db.insert(agentsTable).values({ ...agent, defaultHash: agentHash })
      }
      if (existing.defaultHash !== agentHash) {
        return db
          .update(agentsTable)
          .set({ ...agent, defaultHash: agentHash })
          .where(eq(agentsTable.id, agent.id))
      }
    }),
  )
}

type RegistryResponse = {
  version: string
  agents: Array<{
    id: string
    name: string
    distribution: { remote?: { url: string; transport: string; icon?: string } }
  }>
}

type DiscoveryDeps = {
  getAuthToken?: () => string | null
  httpClient?: HttpClient
}

export const fetchRemoteAgentDescriptors = async (
  cloudUrl: string,
  deps: DiscoveryDeps = {},
): Promise<RemoteAgentDescriptor[]> => {
  const { getAuthToken: getToken = getAuthToken, httpClient = http } = deps
  try {
    const token = getToken()
    const data = await httpClient
      .get(`${cloudUrl}/agents`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      })
      .json<RegistryResponse>()
    // Backend returns registry format — extract only remote agents
    const remoteEntries = (data.agents ?? []).filter((a) => a.distribution.remote)
    console.info(`[discovery] Fetched ${remoteEntries.length} remote agents from ${cloudUrl}/agents`)
    return remoteEntries.map((a) => ({
      id: a.id,
      name: a.name,
      type: 'remote' as const,
      transport: 'websocket' as const,
      url: a.distribution.remote!.url,
      icon: a.distribution.remote!.icon ?? 'globe',
      isSystem: 1,
      enabled: 1,
    }))
  } catch (err) {
    console.warn('[discovery] Failed to fetch remote agents:', err)
    return []
  }
}

export const discoverAndSeedRemoteAgents = async (db: AnyDrizzleDatabase, cloudUrl: string): Promise<Agent[]> => {
  if (!isAgentTypeEnabled('remote')) {
    return []
  }

  const descriptors = await fetchRemoteAgentDescriptors(cloudUrl)
  if (descriptors.length === 0) {
    return []
  }

  const agents: Agent[] = descriptors.map((d) => ({
    ...d,
    command: null,
    args: null,
    authMethod: null,
    deletedAt: null,
    defaultHash: null,
    userId: null,
    description: null,
    registryId: null,
    installedVersion: null,
    registryVersion: null,
    distributionType: null,
    installPath: null,
    packageName: null,
  }))

  await upsertAgents(db, agents)
  return agents
}

/**
 * Updates the `registryVersion` column for installed registry agents
 * so the UI can show "update available" badges.
 */
export const syncRegistryVersions = async (db: AnyDrizzleDatabase, registryEntries: RegistryEntry[]): Promise<void> => {
  const installedAgents = await db
    .select()
    .from(agentsTable)
    .where(and(isNotNull(agentsTable.registryId), isNull(agentsTable.deletedAt)))

  if (installedAgents.length === 0) {
    return
  }

  const registryByIds = new Map(registryEntries.map((e) => [e.id, e]))

  await Promise.all(
    installedAgents.map((agent) => {
      const entry = registryByIds.get(agent.registryId!)
      if (!entry) {
        return
      }
      if (agent.registryVersion !== entry.version) {
        return db.update(agentsTable).set({ registryVersion: entry.version }).where(eq(agentsTable.id, agent.id))
      }
    }),
  )
}
