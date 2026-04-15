import { createMCPClient } from '@ai-sdk/mcp'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createCredentialStore } from './mcp-auth'
import { createTransport } from './mcp-transports'
import { useDatabase } from '@/contexts'
import type { CredentialStore, McpClient, McpServerConfig, McpServerConnection, McpTransportResult } from '@/types/mcp'

type MCPContextType = {
  servers: McpServerConnection[]
  getEnabledClients: () => { name: string; client: McpClient }[]
  reconnectServer: (serverId: string) => Promise<void>
  authorizeServer: (serverId: string) => Promise<void>
  addServer: (server: McpServerConfig) => Promise<void>
  removeServer: (serverId: string) => void
  updateServerStatus: (serverId: string, enabled: boolean) => void
}

const MCPContext = createContext<MCPContextType | undefined>(undefined)

const reconnectDelays = [2000, 4000, 8000, 16000, 32000, 60000]
const maxAttempts = reconnectDelays.length

/**
 * Owns the transport lifecycle during OAuth discovery.
 * Returns a valid transport + authProvider, or closes the transport and returns an error.
 */
const discoverOAuth = async (
  server: McpServerConfig,
  credentialStore: CredentialStore,
  cloudUrl: string,
): Promise<
  | { transport: { close(): Promise<void> }; authProvider: NonNullable<McpTransportResult['authProvider']> }
  | { error: string }
> => {
  const result = await createTransport(server, credentialStore, { cloudUrl })
  try {
    const provider = result.authProvider
    if (!provider) {
      await result.transport.close()
      return { error: 'Server does not require OAuth' }
    }

    try {
      await createMCPClient({ transport: result.transport })
      await result.transport.close()
      return { error: 'Server connected without requiring OAuth' }
    } catch {
      // Expected — SDK discovered OAuth and stored pendingAuthUrl
    }

    if (!provider.pendingAuthUrl) {
      await result.transport.close()
      return { error: 'Could not discover OAuth authorization URL' }
    }

    return { transport: result.transport, authProvider: provider }
  } catch (err) {
    await result.transport.close()
    throw err
  }
}

export const MCPProvider = ({ children }: { children: ReactNode }) => {
  const db = useDatabase()
  const [servers, setServers] = useState<McpServerConnection[]>([])
  const clientRefs = useRef<Map<string, McpClient>>(new Map())
  const transportRefs = useRef<Map<string, { close(): Promise<void> }>>(new Map())
  const retryTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const serversRef = useRef<McpServerConnection[]>([])
  const credentialStoreRef = useRef(createCredentialStore(db))
  const cloudUrlRef = useRef(import.meta.env.VITE_THUNDERBOLT_CLOUD_URL ?? 'http://localhost:8000/v1')

  serversRef.current = servers

  const createClient = async (config: McpServerConfig): Promise<McpClient> => {
    const result = await createTransport(config, credentialStoreRef.current, {
      cloudUrl: cloudUrlRef.current,
    })
    const { transport, authProvider } = result

    try {
      const client = await createMCPClient({ transport })
      transportRefs.current.set(config.id, transport)
      return client
    } catch (err) {
      // If the server requires OAuth, the SDK calls redirectToAuthorization then throws.
      // On web: redirectToAuthorization does window.location.assign (page navigates away).
      //   The error is expected — on return, useMcpOAuthCallback exchanges the code.
      // On desktop/mobile: waitForAuthCode captures the code, finishAuth exchanges it.
      if (authProvider && err instanceof Error && err.message.includes('Unauthorized')) {
        await transport.close()
        setServers((prev) =>
          prev.map((s) =>
            s.id === config.id
              ? { ...s, client: null, isConnected: false, error: null, errorMessage: 'needsAuth', enabled: true }
              : s,
          ),
        )
        return new Promise<McpClient>(() => {}) // park — user must click Authorize
      }
      throw err
    }
  }

  const connectServer = async (config: McpServerConfig, attempt = 0) => {
    if (!config.enabled) {
      setServers((prev) =>
        prev.map((s) =>
          s.id === config.id
            ? { ...s, client: null, isConnected: false, error: null, errorMessage: null, enabled: false }
            : s,
        ),
      )
      return
    }

    // OAuth servers without stored tokens: show "needsAuth" immediately, don't attempt connection
    if (config.auth.authType === 'oauth') {
      const credential = await credentialStoreRef.current.load(config.id)
      if (!credential) {
        setServers((prev) =>
          prev.map((s) =>
            s.id === config.id
              ? { ...s, client: null, isConnected: false, error: null, errorMessage: 'needsAuth', enabled: true }
              : s,
          ),
        )
        return
      }
    }

    try {
      const client = await createClient(config)
      clientRefs.current.set(config.id, client)
      setServers((prev) =>
        prev.map((s) =>
          s.id === config.id ? { ...s, client, isConnected: true, error: null, errorMessage: null, enabled: true } : s,
        ),
      )
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxAttempts) {
        const delay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)]
        const timeoutId = setTimeout(() => {
          retryTimeouts.current.delete(config.id)
          connectServer(config, attempt + 1)
        }, delay)
        retryTimeouts.current.set(config.id, timeoutId)
        setServers((prev) =>
          prev.map((s) =>
            s.id === config.id
              ? {
                  ...s,
                  client: null,
                  isConnected: false,
                  error,
                  errorMessage: `Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${maxAttempts})`,
                  enabled: config.enabled,
                }
              : s,
          ),
        )
      } else {
        setServers((prev) =>
          prev.map((s) =>
            s.id === config.id
              ? { ...s, client: null, isConnected: false, error, errorMessage: error.message, enabled: config.enabled }
              : s,
          ),
        )
      }
    }
  }

  const disconnectServer = async (serverId: string) => {
    const pendingRetry = retryTimeouts.current.get(serverId)
    if (pendingRetry) {
      clearTimeout(pendingRetry)
      retryTimeouts.current.delete(serverId)
    }

    const transport = transportRefs.current.get(serverId)
    if (transport) {
      await transport.close()
      transportRefs.current.delete(serverId)
    }

    const client = clientRefs.current.get(serverId)
    if (client?.close) {
      await client.close()
    }
    clientRefs.current.delete(serverId)
  }

  const addServer = useCallback(async (server: McpServerConfig) => {
    // Idempotent — skip if server already exists in the provider
    setServers((prev) => {
      if (prev.some((s) => s.id === server.id)) {
        return prev
      }
      return [
        ...prev,
        {
          ...server,
          client: null,
          isConnected: false,
          error: null,
          errorMessage: null,
        },
      ]
    })

    if (server.enabled) {
      await connectServer(server)
    }
  }, [])

  const removeServer = useCallback(async (serverId: string) => {
    await disconnectServer(serverId)
    await credentialStoreRef.current.delete(serverId)
    setServers((prev) => prev.filter((s) => s.id !== serverId))
  }, [])

  const updateServerStatus = useCallback(async (serverId: string, enabled: boolean) => {
    const server = serversRef.current.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    if (enabled) {
      await connectServer({ ...server, enabled })
    } else {
      await disconnectServer(serverId)
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, client: null, isConnected: false, error: null, errorMessage: null, enabled: false }
            : s,
        ),
      )
    }
  }, [])

  const reconnectServer = useCallback(async (serverId: string) => {
    const server = serversRef.current.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    await disconnectServer(serverId)
    await connectServer(server, 0)
  }, [])

  /**
   * User-initiated OAuth — called from the "Authorize" button on the server card.
   * Triggers a connection attempt to run OAuth discovery, then redirects the user.
   * - Web: redirects the page (callback hook handles the return).
   * - Desktop/Mobile: opens system browser, waits for code, exchanges, reconnects.
   */
  const authorizeServer = useCallback(async (serverId: string) => {
    const server = serversRef.current.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, errorMessage: 'Discovering OAuth endpoints...' } : s)),
    )

    const discoveryResult = await discoverOAuth(server, credentialStoreRef.current, cloudUrlRef.current).catch(
      (err) => ({ error: err instanceof Error ? err.message : 'OAuth discovery failed' }),
    )

    if ('error' in discoveryResult) {
      setServers((prev) => prev.map((s) => (s.id === serverId ? { ...s, errorMessage: discoveryResult.error } : s)))
      return
    }

    const { transport, authProvider } = discoveryResult

    // Commit transport — authorizeServer now owns its lifecycle via transportRefs
    transportRefs.current.set(serverId, transport)

    try {
      setServers((prev) =>
        prev.map((s) => (s.id === serverId ? { ...s, errorMessage: 'Waiting for authorization...' } : s)),
      )

      await authProvider.startOAuthRedirect()

      // On web, the page navigates away — nothing more to do here.
      // On desktop/mobile, the browser opened and we need to wait for the code.
      const code = await authProvider.waitForAuthCode()
      const httpTransport = transport as unknown as { finishAuth(code: string): Promise<void> }
      await httpTransport.finishAuth(code)

      // Reconnect with the new tokens
      await disconnectServer(serverId)
      await connectServer(server, 0)
    } catch (err) {
      await disconnectServer(serverId)
      const message = err instanceof Error ? err.message : 'Authorization failed'
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, error: err instanceof Error ? err : new Error(message), errorMessage: message }
            : s,
        ),
      )
    }
  }, [])

  const getEnabledClients = useCallback(
    (): { name: string; client: McpClient }[] =>
      serversRef.current
        .filter((server) => server.enabled && server.isConnected && server.client)
        .map((server) => ({ name: server.name, client: server.client! })),
    [],
  )

  // Cleanup on unmount
  useEffect(() => {
    const clients = clientRefs
    const transports = transportRefs
    const timeouts = retryTimeouts
    return () => {
      timeouts.current.forEach((timeout) => clearTimeout(timeout))
      timeouts.current.clear()

      transports.current.forEach((transport) => transport.close())
      transports.current.clear()

      clients.current.forEach((client) => {
        if (client?.close) {
          client.close()
        }
      })
      clients.current.clear()
    }
  }, [])

  return (
    <MCPContext.Provider
      value={{
        servers,
        getEnabledClients,
        reconnectServer,
        authorizeServer,
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
