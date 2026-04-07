import { createMCPClient } from '@ai-sdk/mcp'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createCredentialStore } from './mcp-auth'
import type { McpOAuthClientProvider } from './mcp-auth/oauth-client-provider'
import { createTransport } from './mcp-transports'
import { useDatabase } from '@/contexts'
import type { McpClient, McpServerConfig, McpServerConnection } from '@/types/mcp'

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

export const MCPProvider = ({ children }: { children: ReactNode }) => {
  const db = useDatabase()
  const [servers, setServers] = useState<McpServerConnection[]>([])
  const clientRefs = useRef<Map<string, McpClient>>(new Map())
  const transportRefs = useRef<Map<string, { close(): Promise<void> }>>(new Map())
  const authProviderRefs = useRef<Map<string, McpOAuthClientProvider>>(new Map())
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
        // All platforms: don't redirect automatically. Store the auth provider
        // so the "Authorize" button on the server card can trigger the redirect.
        authProviderRefs.current.set(config.id, authProvider as McpOAuthClientProvider)
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
      connectServer({ ...server, enabled })
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

  const reconnectServer = async (serverId: string) => {
    const server = serversRef.current.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    await disconnectServer(serverId)
    await connectServer(server, 0)
  }

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

    // Step 1: Attempt connection to trigger SDK OAuth discovery
    const discoveryResult = await (async () => {
      const result = await createTransport(server, credentialStoreRef.current, {
        cloudUrl: cloudUrlRef.current,
      })
      const provider = result.authProvider as McpOAuthClientProvider | undefined
      if (!provider) {
        return { error: 'Server does not require OAuth' } as const
      }

      authProviderRefs.current.set(serverId, provider)
      transportRefs.current.set(serverId, result.transport)

      // This triggers OAuth discovery → redirectToAuthorization (stores pendingAuthUrl) → throws
      try {
        await createMCPClient({ transport: result.transport })
        return { error: 'Server connected without requiring OAuth' } as const
      } catch {
        // Expected — SDK discovered OAuth and stored pendingAuthUrl
      }

      return { transport: result.transport, authProvider: provider } as const
    })().catch((err) => ({ error: err instanceof Error ? err.message : 'OAuth discovery failed' }) as const)

    if ('error' in discoveryResult) {
      setServers((prev) =>
        prev.map((s) => (s.id === serverId ? { ...s, errorMessage: discoveryResult.error ?? null } : s)),
      )
      return
    }

    const { transport, authProvider } = discoveryResult

    if (!authProvider.pendingAuthUrl) {
      setServers((prev) =>
        prev.map((s) => (s.id === serverId ? { ...s, errorMessage: 'Could not discover OAuth authorization URL' } : s)),
      )
      return
    }

    // Step 2: Redirect the user
    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, errorMessage: 'Waiting for authorization...' } : s)),
    )

    await authProvider.startOAuthRedirect()

    // On web, the page navigates away — nothing more to do here.
    // On desktop/mobile, the browser opened and we need to wait for the code.
    try {
      const code = await authProvider.waitForAuthCode()
      const httpTransport = transport as unknown as { finishAuth(code: string): Promise<void> }
      await httpTransport.finishAuth(code)

      // Reconnect with the new tokens
      await disconnectServer(serverId)
      await connectServer(server, 0)
    } catch (err) {
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
