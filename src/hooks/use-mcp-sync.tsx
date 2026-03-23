import { useDatabase } from '@/contexts'
import { getAllMcpServers } from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import { isSupportedTransport } from '@/lib/mcp-utils'
import type { McpAuthType, McpTransportType } from '@/types/mcp'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useEffect, useRef } from 'react'

export const useMcpSync = () => {
  const db = useDatabase()
  const { servers, addServer, removeServer, updateServerStatus } = useMCP()
  const serversRef = useRef(servers)

  // Keep ref in sync with state to avoid including `servers` in the effect dep array
  useEffect(() => {
    serversRef.current = servers
  }, [servers])

  const { data: dbServers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getAllMcpServers(db)),
  })

  // Sync database servers with MCP provider
  useEffect(() => {
    const syncServers = async () => {
      const currentServers = serversRef.current
      const providerServerIds = new Set(currentServers.map((s) => s.id))

      // Add new servers from database that aren't in provider (skip unsupported transports)
      for (const dbServer of dbServers) {
        const transportType = (dbServer.type as McpTransportType) ?? 'http'
        if (!providerServerIds.has(dbServer.id) && isSupportedTransport(transportType)) {
          await addServer({
            id: dbServer.id,
            name: dbServer.name ?? 'Unnamed Server',
            enabled: dbServer.enabled === 1,
            transport: {
              type: (dbServer.type as McpTransportType) ?? 'http',
              url: dbServer.url ?? undefined,
              command: dbServer.command ?? undefined,
              args: dbServer.args ? (JSON.parse(dbServer.args) as string[]) : undefined,
            },
            auth: {
              authType: (dbServer.authType as McpAuthType) ?? 'none',
              credentialKey: dbServer.encryptedCredential ? dbServer.id : undefined,
              oauthAccountId: dbServer.oauthAccountId ?? undefined,
            },
          })
        }
      }

      // Remove servers from provider that aren't in database
      const dbServerIds = new Set(dbServers.map((s) => s.id))
      for (const providerServer of currentServers) {
        if (!dbServerIds.has(providerServer.id)) {
          removeServer(providerServer.id)
        }
      }

      // Update server status for existing servers
      for (const dbServer of dbServers) {
        const providerServer = currentServers.find((s) => s.id === dbServer.id)
        if (providerServer && providerServer.enabled !== (dbServer.enabled === 1)) {
          updateServerStatus(dbServer.id, dbServer.enabled === 1)
        }
      }
    }

    syncServers()
  }, [dbServers, addServer, removeServer, updateServerStatus])

  return { servers, dbServers }
}
