/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useCreateItem } from '@/components/create-item/context'
import { useDatabase } from '@/contexts'
import { getRemoteMcpServers } from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import { getMemoryMcpProvider } from '@/memory/providers'

/** Read shared connection records without creating a second MCP sync owner. */
export const useMemoryConnectionsState = () => {
  const db = useDatabase()
  const { openCreateItem } = useCreateItem()
  const { servers: liveServers } = useMCP()
  const { data: servers = [], isLoading } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getRemoteMcpServers(db)),
  })
  const connections = servers.flatMap((server) => {
    const provider = getMemoryMcpProvider(server.url)
    if (!provider) {
      return []
    }
    return [
      {
        id: server.id,
        providerId: provider.id,
        name: server.name || provider.name,
        disabled: server.enabled === 0,
        connected: liveServers.some((live) => live.id === server.id && live.isConnected),
      },
    ]
  })
  return {
    connections,
    isLoading,
    add: () => openCreateItem({ kind: 'connection', memoryOnly: true }),
    manage: (mcpServerId: string) => openCreateItem({ kind: 'connection', mcpServerId }),
  }
}
