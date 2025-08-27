import { getAllMcpServers } from '@/lib/dal'
import { useMCP } from '@/lib/mcp-provider'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

export function useMcpSync() {
  const { servers, addServer, removeServer, updateServerStatus } = useMCP()

  const { data: dbServers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: getAllMcpServers,
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
