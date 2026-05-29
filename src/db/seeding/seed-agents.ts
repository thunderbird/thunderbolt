/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../database-interface'
import { agentsSystemTable } from '../tables'
import { HttpError, type HttpClient } from '@/lib/http'
import { nowIso } from '@/lib/utils'
import type { AgentDiscoveryResponse } from '@shared/acp-types'

/** Result envelope for `refreshSystemAgents`.
 *  - `refreshed: true`  → backend returned 200, local table was upserted.
 *  - `refreshed: false` → no update applied; `reason` explains why. Existing
 *    rows are preserved unless `reason === 'unauthenticated'`, in which case
 *    the table was cleared (the user can no longer see system agents). */
export type RefreshSystemAgentsResult =
  | { refreshed: true }
  | { refreshed: false; reason: 'unauthenticated' | 'network' }

/**
 * Reconcile the local-only `agents_system` table against the backend's
 * `GET /agents` discovery endpoint. Called on bootstrap.
 *
 * Behavior:
 * - 200 → upsert every returned agent into `agents_system` (stamping `fetchedAt`),
 *   delete any local row whose id is no longer in the response. Returns `{ refreshed: true }`.
 * - 401 / 403 → caller is unauthenticated or anonymous; system agents are not
 *   visible. Clear the local table and return `{ refreshed: false, reason: 'unauthenticated' }`.
 * - any other failure (network, 5xx, parse error) → leave existing rows
 *   untouched and return `{ refreshed: false, reason: 'network' }`. The user
 *   keeps the previously-seeded list and can retry later.
 *
 * `httpClient` must be authenticated (`createAuthenticatedClient`) so the
 * request carries `Authorization` + `X-Device-ID`. The bootstrap caller MUST
 * NOT invoke this on anonymous sessions (a 403 will still be handled
 * gracefully, but skipping the call avoids needless backend load).
 */
export const refreshSystemAgents = async (
  db: AnyDrizzleDatabase,
  cloudUrl: string,
  httpClient: HttpClient,
): Promise<RefreshSystemAgentsResult> => {
  const payload = await fetchDiscovery(cloudUrl, httpClient)

  if (payload.kind === 'unauthenticated') {
    await db.delete(agentsSystemTable)
    return { refreshed: false, reason: 'unauthenticated' }
  }

  if (payload.kind === 'error') {
    return { refreshed: false, reason: 'network' }
  }

  const fetchedAt = nowIso()
  // `agents_system` only stores `managed-acp` agents per schema. The discovery
  // response is typed wider (`remote-acp | managed-acp`); `remote-acp` entries
  // belong in the synced `agents` table via user opt-in and are skipped here.
  const incoming = payload.data.agents.filter((a) => a.type === 'managed-acp')

  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: agentsSystemTable.id }).from(agentsSystemTable).all()
    const incomingIds = new Set(incoming.map((a) => a.id))

    for (const { id } of existing) {
      if (!incomingIds.has(id)) {
        await tx.delete(agentsSystemTable).where(eq(agentsSystemTable.id, id))
      }
    }

    for (const agent of incoming) {
      const row = await tx.select().from(agentsSystemTable).where(eq(agentsSystemTable.id, agent.id)).get()
      const values = {
        id: agent.id,
        name: agent.name,
        type: 'managed-acp' as const,
        transport: agent.transport,
        url: agent.url,
        description: agent.description,
        icon: agent.icon,
        fetchedAt,
      }
      if (row) {
        await tx.update(agentsSystemTable).set(values).where(eq(agentsSystemTable.id, agent.id))
      } else {
        await tx.insert(agentsSystemTable).values(values)
      }
    }
  })

  return { refreshed: true }
}

type DiscoveryFetch = { kind: 'ok'; data: AgentDiscoveryResponse } | { kind: 'unauthenticated' } | { kind: 'error' }

/** Hits `GET {cloudUrl}/agents` and classifies the outcome into a closed union.
 *  Kept private — callers consume `refreshSystemAgents` which folds this into
 *  the local-table reconciliation. */
const fetchDiscovery = async (cloudUrl: string, httpClient: HttpClient): Promise<DiscoveryFetch> => {
  try {
    const data = await httpClient.get(`${cloudUrl}/agents`).json<AgentDiscoveryResponse>()
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
