/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../database-interface'
import { agentsSystemTable } from '../tables'
import { HttpError, type HttpClient } from '@/lib/http'
import { nowIso } from '@/lib/utils'
import type { AgentDiscoveryResponse, RemoteAgentDescriptor } from '@shared/acp-types'
import { clearAcpSessionIdsForAgent } from '@/dal/chat-threads'
import { systemRowToAgent } from '@/dal/agents'
import { disposeAdapter } from '@/acp/adapter-cache'
import type { Agent } from '@/types/acp'

/** Result envelope for `refreshSystemAgents`.
 *  - `refreshed: true`  → backend returned 200, local table was upserted.
 *    `defaultAgent` is the agent the response names as `defaultAgentId`, or
 *    null when it names none.
 *  - `refreshed: false` → no update applied; `reason` explains why. Existing
 *    rows are preserved unless `reason === 'unauthenticated'`, in which case
 *    the table was cleared (the user can no longer see system agents). */
export type RefreshSystemAgentsResult =
  | { refreshed: true; wireIdentityChangedAgents: Agent[]; defaultAgent: Agent | null }
  | { refreshed: false; reason: 'unauthenticated' | 'network' }

/**
 * Reconcile the local-only `agents_system` table against the backend's
 * `GET /agents` discovery endpoint. Called on bootstrap.
 *
 * Behavior:
 * - 200 → upsert every returned agent into `agents_system` (stamping `fetchedAt`),
 *   delete any local row whose id is no longer in the response. Returns `{ refreshed: true }`.
 * - 401 / 403 → caller is unauthenticated, or anonymous on a deployment without
 *   anonymous discovery; system agents are not visible. Clear the local table
 *   and return `{ refreshed: false, reason: 'unauthenticated' }`.
 * - any other failure (network, 5xx, parse error) → leave existing rows
 *   untouched and return `{ refreshed: false, reason: 'network' }`. The user
 *   keeps the previously-seeded list and can retry later.
 *
 * `httpClient` must be authenticated (`createAuthenticatedClient`) so the
 * request carries `Authorization` + `X-Device-ID`. Anonymous sessions call it
 * too: the backend returns their `anonymousSafe` agents when anonymous
 * discovery is on, and a 403 otherwise.
 */
export const refreshSystemAgents = async (
  db: AnyDrizzleDatabase,
  httpClient: HttpClient,
): Promise<RefreshSystemAgentsResult> => {
  const payload = await fetchDiscovery(httpClient)

  if (payload.kind === 'unauthenticated') {
    await db.delete(agentsSystemTable)
    return { refreshed: false, reason: 'unauthenticated' }
  }

  if (payload.kind === 'error') {
    return { refreshed: false, reason: 'network' }
  }

  const fetchedAt = nowIso()
  // `agents_system` stores the server-run agents: `managed-acp` and
  // `managed-http`. `remote-acp` entries belong in the synced `agents` table
  // via user opt-in.
  const incoming = payload.data.agents.filter(
    (a): a is RemoteAgentDescriptor & { type: 'managed-acp' | 'managed-http' } => a.type !== 'remote-acp',
  )
  const { defaultAgentId } = payload.data
  const incomingRows = incoming.map((agent) => ({
    id: agent.id,
    name: agent.name,
    type: agent.type,
    transport: agent.transport,
    url: agent.url,
    description: agent.description,
    icon: agent.icon,
    fetchedAt,
    isDefault: agent.id === defaultAgentId ? 1 : 0,
  }))
  const defaultRow = incomingRows.find((row) => row.isDefault === 1)
  const wireIdentityChangedAgentsById = new Map<string, Agent>()

  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: agentsSystemTable.id }).from(agentsSystemTable).all()
    const incomingIds = new Set(incomingRows.map((a) => a.id))

    for (const { id } of existing) {
      if (!incomingIds.has(id)) {
        await tx.delete(agentsSystemTable).where(eq(agentsSystemTable.id, id))
      }
    }

    for (const values of incomingRows) {
      const row = await tx.select().from(agentsSystemTable).where(eq(agentsSystemTable.id, values.id)).get()
      if (row) {
        const wireIdentityChanged = row.url !== values.url || row.transport !== values.transport
        await tx.update(agentsSystemTable).set(values).where(eq(agentsSystemTable.id, values.id))
        if (wireIdentityChanged) {
          await clearAcpSessionIdsForAgent(tx, values.id)
          wireIdentityChangedAgentsById.set(values.id, systemRowToAgent(values))
        }
      } else {
        await tx.insert(agentsSystemTable).values(values)
      }
    }
  })

  const wireIdentityChangedAgents = [...wireIdentityChangedAgentsById.values()]
  await Promise.all(wireIdentityChangedAgents.map((agent) => disposeAdapter(agent.id)))

  return {
    refreshed: true,
    wireIdentityChangedAgents,
    defaultAgent: defaultRow ? systemRowToAgent(defaultRow) : null,
  }
}

type DiscoveryFetch = { kind: 'ok'; data: AgentDiscoveryResponse } | { kind: 'unauthenticated' } | { kind: 'error' }

/** Hits `GET /agents` through the preconfigured client and classifies the outcome into a closed union.
 *  Kept private — callers consume `refreshSystemAgents` which folds this into
 *  the local-table reconciliation. */
const fetchDiscovery = async (httpClient: HttpClient): Promise<DiscoveryFetch> => {
  try {
    const data = await httpClient.get('agents').json<AgentDiscoveryResponse>()
    return { kind: 'ok', data }
  } catch (err) {
    if (err instanceof HttpError) {
      const status = err.response.status
      if (status === 401 || status === 403) {
        return { kind: 'unauthenticated' }
      }
    }
    return { kind: 'error' }
  }
}
