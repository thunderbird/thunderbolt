/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMCPClient } from '@ai-sdk/mcp'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDatabase } from '@/contexts'
import { getMcpServerCredentials } from '@/dal/mcp-secrets'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { buildMcpHeaders, createMcpTransport, type MCPTransportType } from './mcp-transport'

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>

type MCPServer = {
  id: string
  name: string
  url: string
  type: MCPTransportType
  enabled: boolean
}

type MCPServerConnection = MCPServer & {
  client: MCPClient | null
  isConnected: boolean
  error: Error | null
}

/** Reconnect a dropped MCP client at the `tools()` boundary. Looks up the
 *  server behind `client` and returns a freshly connected client, or null when
 *  the server is gone/disabled or the reconnect failed. */
type ReconnectClient = (client: MCPClient) => Promise<MCPClient | null>

/** An enabled, connected client paired with its server name. The name is the
 *  tool-namespacing prefix consumed by `mergeMcpTools` so different servers'
 *  tools don't collide. */
type NamedMCPClient = { name: string; client: MCPClient }

type MCPContextType = {
  servers: MCPServerConnection[]
  getEnabledClients: () => NamedMCPClient[]
  reconnectServer: (serverId: string) => Promise<MCPClient | null>
  reconnectClient: ReconnectClient
  addServer: (server: MCPServer) => Promise<void>
  removeServer: (serverId: string) => void
  updateServerStatus: (serverId: string, enabled: boolean) => void
}

const MCPContext = createContext<MCPContextType | undefined>(undefined)

/** Connect a single MCP server using its on-device credentials. Extracted as a
 *  free function so tests can inject a fake via {@link MCPProvider}'s
 *  `createClient` prop without touching the AI SDK / proxy stack. */
type CreateClientFn = (serverId: string, url: string, type: MCPTransportType) => Promise<MCPClient>

type MCPProviderProps = {
  children: ReactNode
  /** Test-only DI seam. Production builds the real proxy-routed client. */
  createClient?: CreateClientFn
}

export const MCPProvider = ({ children, createClient: injectedCreateClient }: MCPProviderProps) => {
  const [servers, setServers] = useState<MCPServerConnection[]>([])
  const clientRefs = useRef<Map<string, MCPClient>>(new Map())
  const clientToServerId = useRef<Map<MCPClient, string>>(new Map())
  const reconnectsInFlight = useRef<Map<string, Promise<MCPClient | null>>>(new Map())
  const serversRef = useRef<MCPServerConnection[]>([])
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const db = useDatabase()

  /** Update the server list AND `serversRef` in lockstep — this is the SOLE
   *  writer of `servers`, so the ref stays in sync without a render-phase
   *  mirror. The ref is the synchronous source of truth: async reconnect logic
   *  re-checks it after an await to detect a server removed/disabled mid-flight,
   *  which can't wait for React to flush the render that would otherwise refresh
   *  the ref. */
  const commitServers = (next: (prev: MCPServerConnection[]) => MCPServerConnection[]) => {
    serversRef.current = next(serversRef.current)
    setServers(serversRef.current)
  }

  const defaultCreateClient: CreateClientFn = async (serverId, url, type) => {
    // Re-reads credentials from the db, so a refreshed token is picked up on reconnect.
    const credentials = await getMcpServerCredentials(db, serverId)
    const headers = buildMcpHeaders(credentials?.type === 'bearer' ? credentials.token : undefined)
    const transport = createMcpTransport(url, type, cloudUrl, headers)
    const mcpClient = await createMCPClient({ transport })
    return mcpClient
  }

  const createClient = injectedCreateClient ?? defaultCreateClient

  /** Cache a freshly connected client and maintain the client→serverId reverse lookup. */
  const cacheClient = (serverId: string, client: MCPClient) => {
    clientRefs.current.set(serverId, client)
    clientToServerId.current.set(client, serverId)
  }

  const connectServer = async (server: MCPServer) => {
    if (!server.enabled) {
      commitServers((prev) =>
        prev.map((s) =>
          s.id === server.id ? { ...s, client: null, isConnected: false, error: null, enabled: false } : s,
        ),
      )
      return
    }

    try {
      const client = await createClient(server.id, server.url, server.type)

      cacheClient(server.id, client)

      commitServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, client, isConnected: true, error: null, enabled: true } : s)),
      )
    } catch (err) {
      console.error('Failed to connect to MCP server:', server.name, err)
      commitServers((prev) =>
        prev.map((s) =>
          s.id === server.id
            ? { ...s, client: null, isConnected: false, error: err as Error, enabled: server.enabled }
            : s,
        ),
      )
    }
  }

  /** Close and forget a client, clearing both lookup directions. */
  const closeClient = (client: MCPClient) => {
    if (client.close) {
      try {
        client.close()
      } catch (error) {
        console.error('Error closing MCP client:', error)
      }
    }
    clientToServerId.current.delete(client)
  }

  const disconnectServer = (serverId: string) => {
    const client = clientRefs.current.get(serverId)
    if (client) {
      closeClient(client)
    }
    clientRefs.current.delete(serverId)
  }

  const addServer = async (server: MCPServer) => {
    // Idempotency guard against the synchronous source of truth. Two sync
    // consumers can each observe a stale server list and call addServer for the
    // same id before React re-renders — skip the duplicate so the server isn't
    // registered (and connected) twice.
    if (serversRef.current.some((s) => s.id === server.id)) {
      return
    }

    commitServers((prev) => [
      ...prev,
      {
        ...server,
        client: null,
        isConnected: false,
        error: null,
      },
    ])

    if (server.enabled) {
      await connectServer(server)
    }
  }

  const removeServer = (serverId: string) => {
    disconnectServer(serverId)
    commitServers((prev) => prev.filter((s) => s.id !== serverId))
  }

  const updateServerStatus = (serverId: string, enabled: boolean) => {
    const server = serversRef.current.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    if (enabled) {
      connectServer({ ...server, enabled })
    } else {
      disconnectServer(serverId)
      commitServers((prev) =>
        prev.map((s) =>
          s.id === serverId ? { ...s, client: null, isConnected: false, error: null, enabled: false } : s,
        ),
      )
    }
  }

  /** Open a fresh connection for `serverId`, committing it only if the server is
   *  still enabled by the time the connect resolves; otherwise close the orphan.
   *  Idempotent + coalesced: concurrent calls for the same server share one
   *  in-flight promise so a drop can't trigger a reconnect storm. */
  const reconnectServer = (serverId: string): Promise<MCPClient | null> => {
    const inFlight = reconnectsInFlight.current.get(serverId)
    if (inFlight) {
      return inFlight
    }

    const server = serversRef.current.find((s) => s.id === serverId)
    if (!server || !server.enabled) {
      return Promise.resolve(null)
    }

    const promise = (async (): Promise<MCPClient | null> => {
      // Tear down the stale connection before opening a new one.
      disconnectServer(serverId)

      try {
        const client = await createClient(server.id, server.url, server.type)

        // The server may have been removed/disabled while we were connecting —
        // close the orphan rather than caching a client nothing can reach.
        const current = serversRef.current.find((s) => s.id === serverId)
        if (!current || !current.enabled) {
          closeClient(client)
          return null
        }

        cacheClient(serverId, client)
        commitServers((prev) =>
          prev.map((s) => (s.id === serverId ? { ...s, client, isConnected: true, error: null } : s)),
        )
        return client
      } catch (err) {
        console.error('Failed to reconnect MCP server:', server.name, err)
        commitServers((prev) =>
          prev.map((s) => (s.id === serverId ? { ...s, client: null, isConnected: false, error: err as Error } : s)),
        )
        return null
      }
    })()

    reconnectsInFlight.current.set(serverId, promise)
    return promise.finally(() => {
      reconnectsInFlight.current.delete(serverId)
    })
  }

  const reconnectClient: ReconnectClient = (client) => {
    const serverId = clientToServerId.current.get(client)
    if (!serverId) {
      return Promise.resolve(null)
    }
    return reconnectServer(serverId)
  }

  const getEnabledClients = (): NamedMCPClient[] => {
    // Use ref to always get current servers, avoiding stale closures
    return serversRef.current
      .filter((server) => server.enabled && server.isConnected && server.client)
      .map((server) => ({ name: server.name, client: server.client! }))
  }

  // Cleanup on unmount
  useEffect(() => {
    const clientsRef = clientRefs
    const reverseRef = clientToServerId
    return () => {
      const clients = clientsRef.current
      clients.forEach((client, serverId) => {
        if (client?.close) {
          try {
            client.close()
          } catch (error) {
            console.error('Error closing MCP client:', serverId, error)
          }
        }
      })
      clients.clear()
      reverseRef.current.clear()
    }
  }, [])

  return (
    <MCPContext.Provider
      value={{
        servers,
        getEnabledClients,
        reconnectServer,
        reconnectClient,
        addServer,
        removeServer,
        updateServerStatus,
      }}
    >
      {children}
    </MCPContext.Provider>
  )
}

export const useMCP = () => {
  const context = useContext(MCPContext)
  if (!context) {
    throw new Error('useMCP must be used within an MCPProvider')
  }
  return context
}

// Export the MCPClient + ReconnectClient + NamedMCPClient types for use in other files
export type { MCPClient, NamedMCPClient, ReconnectClient }
