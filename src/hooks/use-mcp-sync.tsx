import { useDatabase } from '@/contexts'
import { getAllMcpServers } from '@/dal'
import type { McpServer } from '@/types'
import { useMCP } from '@/lib/mcp-provider'
import { isSupportedTransport } from '@/lib/mcp-utils'
import type { McpAuthType, McpServerConfig, McpTransportType } from '@/types/mcp'
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

const buildServerConfig = (dbServer: McpServer): McpServerConfig => ({
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

export const useMcpSync = () => {
  const db = useDatabase()
  const { servers, addServer, removeServer, updateServerStatus } = useMCP()
  const serversRef = useRef(servers)
  serversRef.current = servers

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
          await addServer(buildServerConfig(dbServer))
        }
      }

      // Remove servers from provider that aren't in database
      const dbServerIds = new Set(dbServers.map((s) => s.id))
      for (const providerServer of currentServers) {
        if (!dbServerIds.has(providerServer.id)) {
          removeServer(providerServer.id)
        }
      }

      // Update existing servers — re-add if config changed, otherwise sync enabled status
      for (const dbServer of dbServers) {
        const providerServer = currentServers.find((s) => s.id === dbServer.id)
        if (!providerServer) {
          continue
        }

        const newConfig = buildServerConfig(dbServer)
        const configChanged = JSON.stringify(providerServer.transport) !== JSON.stringify(newConfig.transport)

        if (configChanged) {
          await removeServer(dbServer.id)
          await addServer(newConfig)
        } else if (providerServer.enabled !== newConfig.enabled) {
          await updateServerStatus(dbServer.id, newConfig.enabled)
        }
      }
    }

    syncServers()
  }, [dbServers, addServer, removeServer, updateServerStatus])

  return { servers, dbServers }
}
