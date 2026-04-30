/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMCPClient } from '@ai-sdk/mcp'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useProxyUrl } from './proxy-url'
import { TauriStreamableHTTPClientTransport } from './tauri-http-transport'

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>

type MCPServerConnection = {
  id: string
  name: string
  url: string
  client: MCPClient | null
  isConnected: boolean
  error: Error | null
  enabled: boolean
}

type MCPContextType = {
  servers: MCPServerConnection[]
  getEnabledClients: () => MCPClient[]
  reconnectServer: (serverId: string) => Promise<void>
  addServer: (server: { id: string; name: string; url: string; enabled: boolean }) => Promise<void>
  removeServer: (serverId: string) => void
  updateServerStatus: (serverId: string, enabled: boolean) => void
}

const MCPContext = createContext<MCPContextType | undefined>(undefined)

/**
 * Build the MCP transport for a given upstream server URL.
 *
 * Routing:
 *   - When `proxyUrl(target)` returns a different URL (i.e. the unified
 *     `/v1/proxy/<encoded>` route), MCP traffic flows through the backend
 *     proxy. The proxy is same-origin from the browser, so the standard
 *     `StreamableHTTPClientTransport` (browser `fetch`) handles it without
 *     CORS friction.
 *   - When `proxyUrl(target) === target` (Tauri/mobile with `proxy_enabled`
 *     OFF), the transport hits the upstream directly. The native browser
 *     `fetch` on Tauri is still subject to webview CORS for cross-origin
 *     responses, so we fall back to `TauriStreamableHTTPClientTransport`
 *     which routes through `@tauri-apps/plugin-http` to bypass CORS.
 *
 * Upstream auth is forwarded as `X-Upstream-Authorization` (the proxy
 * renames it to `Authorization` before forwarding to the upstream MCP
 * server). The plain `Authorization` header is never sent from this client
 * — it is reserved for proxy authentication (session cookie today).
 */
export const createMcpTransport = (target: string, effectiveUrl: string) => {
  const transportOptions = {
    requestInit: {
      headers: {
        Accept: 'application/json, text/event-stream',
      },
    },
  }
  const urlObj = new URL(effectiveUrl)
  const isProxied = effectiveUrl !== target
  // Same-origin proxy → standard fetch is fine. Direct upstream on Tauri →
  // route through Tauri-native fetch to bypass webview CORS.
  return isProxied
    ? new StreamableHTTPClientTransport(urlObj, transportOptions)
    : new TauriStreamableHTTPClientTransport(urlObj, transportOptions)
}

export const MCPProvider = ({ children }: { children: ReactNode }) => {
  const proxyUrl = useProxyUrl()
  const [servers, setServers] = useState<MCPServerConnection[]>([])
  const clientRefs = useRef<Map<string, MCPClient>>(new Map())
  const serversRef = useRef<MCPServerConnection[]>([])

  serversRef.current = servers

  const createClient = async (url: string): Promise<MCPClient> => {
    const transport = createMcpTransport(url, proxyUrl(url))
    const mcpClient = await createMCPClient({
      transport,
    })
    return mcpClient
  }

  const connectServer = async (server: { id: string; name: string; url: string; enabled: boolean }) => {
    if (!server.enabled) {
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id ? { ...s, client: null, isConnected: false, error: null, enabled: false } : s,
        ),
      )
      return
    }

    try {
      // Connecting to MCP server
      const client = await createClient(server.url)

      clientRefs.current.set(server.id, client)

      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, client, isConnected: true, error: null, enabled: true } : s)),
      )

      // MCP server connected successfully
    } catch (err) {
      console.error('Failed to connect to MCP server:', server.name, err)
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id
            ? { ...s, client: null, isConnected: false, error: err as Error, enabled: server.enabled }
            : s,
        ),
      )
    }
  }

  const disconnectServer = (serverId: string) => {
    const client = clientRefs.current.get(serverId)
    if (client?.close) {
      try {
        client.close()
      } catch (error) {
        console.error('Error closing MCP client:', error)
      }
    }
    clientRefs.current.delete(serverId)
  }

  const addServer = async (server: { id: string; name: string; url: string; enabled: boolean }) => {
    // Add server to state first
    setServers((prev) => [
      ...prev,
      {
        ...server,
        client: null,
        isConnected: false,
        error: null,
      },
    ])

    // Then try to connect if enabled
    if (server.enabled) {
      await connectServer(server)
    }
  }

  const removeServer = (serverId: string) => {
    disconnectServer(serverId)
    setServers((prev) => prev.filter((s) => s.id !== serverId))
  }

  const updateServerStatus = (serverId: string, enabled: boolean) => {
    const server = servers.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    if (enabled) {
      connectServer({ ...server, enabled })
    } else {
      disconnectServer(serverId)
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId ? { ...s, client: null, isConnected: false, error: null, enabled: false } : s,
        ),
      )
    }
  }

  const reconnectServer = async (serverId: string) => {
    const server = servers.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    // Reconnecting MCP server
    disconnectServer(serverId)
    await connectServer(server)
  }

  const getEnabledClients = (): MCPClient[] => {
    // Use ref to always get current servers, avoiding stale closures
    return serversRef.current
      .filter((server) => server.enabled && server.isConnected && server.client)
      .map((server) => server.client!)
  }

  // Cleanup on unmount
  useEffect(() => {
    const clientsRef = clientRefs
    return () => {
      // Cleaning up MCP connections
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
    }
  }, [])

  return (
    <MCPContext.Provider
      value={{
        servers,
        getEnabledClients,
        reconnectServer,
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

// Export the MCPClient type for use in other files
export type { MCPClient }
