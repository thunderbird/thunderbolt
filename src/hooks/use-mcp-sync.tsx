import { useDatabase } from '@/contexts'
import { getAllMcpServers } from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import { isSupportedTransport } from '@/lib/mcp-utils'
import type { McpAuthType, McpTransportType } from '@/types/mcp'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useEffect, useRef } from 'react'

/** Parses a JSON string as a string array, returning an empty array on invalid input. */
const parseJsonArray = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

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
            transport:
              dbServer.type === 'stdio'
                ? {
                    type: 'stdio' as const,
                    command: dbServer.command ?? '',
                    args: dbServer.args ? parseJsonArray(dbServer.args) : undefined,
                  }
                : { type: (dbServer.type as 'http' | 'sse') ?? 'http', url: dbServer.url ?? '' },
            auth: {
              authType: (dbServer.authType as McpAuthType) ?? 'none',
              credentialKey: dbServer.authType && dbServer.authType !== 'none' ? dbServer.id : undefined,
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
