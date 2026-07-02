/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMCPClient } from '@ai-sdk/mcp'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDatabase } from '@/contexts'
import { getMcpServerCredentials, type McpServerCredentials } from '@/dal/mcp-secrets'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { getAuthToken } from './auth-token'
import { ensureValidMcpOAuthToken } from './mcp-auth/ensure-valid-token'
import { isUnauthorizedError } from './mcp-errors'
import { buildMcpHeaders, createMcpTransport, type MCPTransportType } from './mcp-transport'
import { computeEffectiveProxyEnabled, createProxyFetch } from './proxy-fetch'

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

/** An enabled, connected client paired with its server identity. `name` is the
 *  tool-namespacing prefix consumed by `mergeMcpTools` so different servers'
 *  tools don't collide; `name` and `url` flow through to the assistant message's
 *  `mcpTools` metadata so chat history can resolve a tool call back to its
 *  server (name, url, icon). */
type NamedMCPClient = { id: string; name: string; url: string; client: MCPClient }

type MCPContextType = {
  servers: MCPServerConnection[]
  getEnabledClients: () => NamedMCPClient[]
  reconnectServer: (serverId: string) => Promise<MCPClient | null>
  reconnectClient: ReconnectClient
  addServer: (server: MCPServer) => Promise<void>
  removeServer: (serverId: string) => void
  /** Apply a row patch (rename / url / type / enabled) and reconcile the
   *  connection: disabled → disconnect; disabled→enabled → connect (coalesces
   *  with any in-flight initial connect); already-enabled → reconnect (closes
   *  the stale client, redials with the new url/type and live credentials).
   *  Credentials (bearer or OAuth) live in `mcp_secrets`; `defaultCreateClient`
   *  re-reads them on every connect, so the redial picks up the new value too.
   *  Set `forceRedial` when the caller just wrote credentials: the redial then
   *  also chains onto any in-flight initial connect so the new credentials
   *  aren't stranded behind a connect that read the old ones at its start.
   *  Returns a promise that resolves once the reconcile (connect / reconnect /
   *  chained reconnect) has settled — callers that don't care can ignore it.
   *  No-op when the id isn't tracked yet. */
  updateServer: (server: MCPServer, options?: { forceRedial?: boolean }) => Promise<void>
}

const MCPContext = createContext<MCPContextType | undefined>(undefined)

/**
 * Resolve the bearer token to inject for a server's outbound MCP requests from
 * its on-device credential blob:
 *   - `bearer`: the static token verbatim.
 *   - `oauth`: a *fresh* access token via {@link ensureValidMcpOAuthToken},
 *     which proactively refreshes near expiry and persists the rotated token —
 *     auto-applied on the next reconnect since `defaultCreateClient` re-reads
 *     credentials each connect. Refresh routes through the same proxy fetch the
 *     transport uses (SSRF-validated by `/v1/proxy` on web).
 *   - none / no row: `undefined` (unauthenticated server).
 * `ensureValidMcpOAuthToken` is injectable so the provider can be unit-tested
 * without the SDK refresh path; production omits it and uses the real one.
 */
export const resolveMcpAccessToken = async (
  db: AnyDrizzleDatabase,
  serverId: string,
  credentials: McpServerCredentials | null,
  cloudUrl: string,
  ensureValidToken: typeof ensureValidMcpOAuthToken = ensureValidMcpOAuthToken,
): Promise<string | undefined> => {
  if (credentials?.type === 'bearer') {
    return credentials.token
  }
  if (credentials?.type === 'oauth') {
    const fetchFn = createProxyFetch({
      cloudUrl,
      getProxyAuthToken: getAuthToken,
      getProxyEnabled: () => computeEffectiveProxyEnabled(),
    })
    return ensureValidToken(db, serverId, fetchFn)
  }
  return undefined
}

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
  const connectsInFlight = useRef<Map<string, Promise<void>>>(new Map())
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
    const token = await resolveMcpAccessToken(db, serverId, credentials, cloudUrl)
    const headers = buildMcpHeaders(token)
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

  const connectServer = (server: MCPServer): Promise<void> => {
    if (!server.enabled) {
      commitServers((prev) =>
        prev.map((s) =>
          s.id === server.id ? { ...s, client: null, isConnected: false, error: null, enabled: false } : s,
        ),
      )
      return Promise.resolve()
    }

    // Coalesce overlapping connects for the same server into one in-flight
    // promise. Two sync consumers can re-fire the enable→connect path before
    // React flushes (the addServer→connect vs updateServer(enable)→connect
    // race), so without this a second createClient could cacheClient over a live
    // client without closing it — leaking the first connection.
    const inFlight = connectsInFlight.current.get(server.id)
    if (inFlight) {
      return inFlight
    }

    const promise = (async (): Promise<void> => {
      try {
        const client = await createClient(server.id, server.url, server.type)

        // The server may have been removed/disabled while we were connecting —
        // close the orphan rather than caching/committing (and re-enabling) a
        // client nothing can reach.
        const current = serversRef.current.find((s) => s.id === server.id)
        if (!current || !current.enabled) {
          closeClient(client)
          return
        }

        cacheClient(server.id, client)

        commitServers((prev) =>
          prev.map((s) => (s.id === server.id ? { ...s, client, isConnected: true, error: null, enabled: true } : s)),
        )
      } catch (err) {
        // A 401 means the server requires authorization and is waiting for a
        // credential / OAuth — expected, not a failure. Keep other errors as errors.
        if (isUnauthorizedError(err)) {
          console.warn('MCP server requires authorization:', server.name)
        } else {
          console.error('Failed to connect to MCP server:', server.name, err)
        }
        // Skip committing an error onto a server that was removed/disabled
        // mid-connect — its row is gone or intentionally off.
        const current = serversRef.current.find((s) => s.id === server.id)
        if (!current || !current.enabled) {
          return
        }
        commitServers((prev) =>
          prev.map((s) =>
            s.id === server.id
              ? { ...s, client: null, isConnected: false, error: err as Error, enabled: server.enabled }
              : s,
          ),
        )
      }
    })()

    connectsInFlight.current.set(server.id, promise)
    return promise.finally(() => {
      connectsInFlight.current.delete(server.id)
    })
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

  /** Apply a row patch from settings or PowerSync sync and reconcile the live
   *  connection. Disabled → disconnect; disabled→enabled → connectServer (so
   *  it coalesces with an in-flight initial connect via `connectsInFlight`);
   *  already-enabled → reconnectServer, which closes the stale client and
   *  redials with the new url/type plus freshly-read credentials (mcp_secrets
   *  changes don't touch the row, so we always redial here even when fields
   *  are unchanged). The in-flight-with-matching-url guard suppresses a second
   *  createClient when an initial connect for the same target is already
   *  underway — unless `forceRedial` is set, in which case we chain a
   *  reconnect onto the in-flight connect so a credential update written by
   *  the caller before this call lands on the live client. */
  const updateServer = async (server: MCPServer, options?: { forceRedial?: boolean }): Promise<void> => {
    const existing = serversRef.current.find((s) => s.id === server.id)
    if (!existing) {
      return
    }

    commitServers((prev) =>
      prev.map((s) =>
        s.id === server.id
          ? { ...s, name: server.name, url: server.url, type: server.type, enabled: server.enabled }
          : s,
      ),
    )

    if (!server.enabled) {
      disconnectServer(server.id)
      commitServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, client: null, isConnected: false, error: null } : s)),
      )
      return
    }

    if (!existing.enabled) {
      await connectServer(server)
      return
    }

    const inFlightConnect = connectsInFlight.current.get(server.id)
    if (inFlightConnect && existing.url === server.url && existing.type === server.type) {
      if (options?.forceRedial) {
        await inFlightConnect
        await reconnectServer(server.id)
      }
      return
    }
    await reconnectServer(server.id)
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
        // Skip committing an error onto a server that was removed/disabled
        // mid-reconnect — its row is gone or intentionally off.
        const current = serversRef.current.find((s) => s.id === serverId)
        if (!current || !current.enabled) {
          return null
        }
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
      .map((server) => ({ id: server.id, name: server.name, url: server.url, client: server.client! }))
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
        updateServer,
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
