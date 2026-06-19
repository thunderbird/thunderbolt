/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getRemoteMcpServers } from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useEffect } from 'react'

export const useMcpSync = () => {
  const db = useDatabase()
  const { servers, addServer, removeServer, updateServer } = useMCP()

  const { data: dbServers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getRemoteMcpServers(db)),
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
            name: dbServer.name ?? '',
            url: dbServer.url || '',
            type: dbServer.type === 'sse' ? 'sse' : 'http',
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

      // Patch any row whose name/url/type/enabled diverged from the in-memory
      // entry. `updateServer` redials when enabled so a URL or transport change
      // actually takes effect (the previous sync only handled enable toggles,
      // leaving editors connected to the old endpoint).
      for (const dbServer of dbServers) {
        const providerServer = servers.find((s) => s.id === dbServer.id)
        if (!providerServer) {
          continue
        }
        const next = {
          id: dbServer.id,
          name: dbServer.name ?? '',
          url: dbServer.url || '',
          type: dbServer.type === 'sse' ? ('sse' as const) : ('http' as const),
          enabled: dbServer.enabled === 1,
        }
        if (
          providerServer.name !== next.name ||
          providerServer.url !== next.url ||
          providerServer.type !== next.type ||
          providerServer.enabled !== next.enabled
        ) {
          updateServer(next)
        }
      }
    }

    syncServers()
  }, [dbServers, servers, addServer, removeServer, updateServer])

  return { servers, dbServers }
}
