/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getAllMcpServers } from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useEffect } from 'react'

export const useMcpSync = () => {
  const db = useDatabase()
  const { servers, addServer, removeServer, updateServerStatus } = useMCP()

  const { data: dbServers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getAllMcpServers(db)),
  })

  // Sync database servers with MCP provider
  useEffect(() => {
    const syncServers = async () => {
      // Get current server IDs in the provider
      const providerServerIds = new Set(servers.map((s) => s.id))

      // Add new servers from database that aren't in provider
      for (const dbServer of dbServers) {
        if (!providerServerIds.has(dbServer.id)) {
          await addServer({
            id: dbServer.id,
            name: dbServer.name,
            url: dbServer.url || '',
            enabled: dbServer.enabled === 1,
          })
        }
      }

      // Remove servers from provider that aren't in database
      const dbServerIds = new Set(dbServers.map((s) => s.id))
      for (const providerServer of servers) {
        if (!dbServerIds.has(providerServer.id)) {
          removeServer(providerServer.id)
        }
      }

      // Update server status for existing servers
      for (const dbServer of dbServers) {
        const providerServer = servers.find((s) => s.id === dbServer.id)
        if (providerServer && providerServer.enabled !== (dbServer.enabled === 1)) {
          updateServerStatus(dbServer.id, dbServer.enabled === 1)
        }
      }
    }

    syncServers()
  }, [dbServers, servers, addServer, removeServer, updateServerStatus])

  return { servers, dbServers }
}
