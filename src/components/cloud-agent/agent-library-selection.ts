/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudAgentDraft } from '@/cloud-agent/client'
import type { CloudMcpLibraryEntry } from '@/cloud-agent/connection-library'

type AgentMcpSelection = Pick<CloudAgentDraft, 'mcpServers' | 'connectionIds'>

/** Upgrade legacy cloud-only selections without granting additional library connections. */
export const selectedAgentMcps = (config: AgentMcpSelection, entries: CloudMcpLibraryEntry[]) => {
  const selected = new Map((config.mcpServers ?? []).map((server) => [server.sourceId, server]))
  for (const entry of entries) {
    if (entry.cloudConnectionId && config.connectionIds.includes(entry.cloudConnectionId)) {
      selected.set(entry.source.id, { sourceId: entry.source.id, name: entry.source.name })
    }
  }
  return [...selected.values()]
}

/** Save portable library selections separately from currently authorized cloud bindings. */
export const resolveAgentMcps = (config: AgentMcpSelection, entries: CloudMcpLibraryEntry[]): AgentMcpSelection => {
  const selected = selectedAgentMcps(config, entries)
  const sourceIds = new Set(selected.map((server) => server.sourceId))
  const cloudIds = entries.flatMap((entry) =>
    sourceIds.has(entry.source.id) && entry.ready && entry.cloudConnectionId ? [entry.cloudConnectionId] : [],
  )
  const legacyIds = config.connectionIds.filter((id) => !entries.some((entry) => entry.cloudConnectionId === id))
  return {
    mcpServers: selected.map((server) => ({
      ...server,
      name: entries.find((entry) => entry.source.id === server.sourceId)?.source.name ?? server.name,
    })),
    connectionIds: [...new Set([...legacyIds, ...cloudIds])],
  }
}
