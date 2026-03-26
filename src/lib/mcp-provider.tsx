import { createMCPClient } from '@ai-sdk/mcp'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createCredentialStore } from './mcp-auth'
import { createTransport } from './mcp-transports'
import { useDatabase } from '@/contexts'
import type { McpClient, McpServerConfig, McpServerConnection } from '@/types/mcp'

type MCPContextType = {
  servers: McpServerConnection[]
  getEnabledClients: () => McpClient[]
  reconnectServer: (serverId: string) => Promise<void>
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
  const retryTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const serversRef = useRef<McpServerConnection[]>([])
  const credentialStoreRef = useRef(createCredentialStore(db))
  const cloudUrlRef = useRef(import.meta.env.VITE_THUNDERBOLT_CLOUD_URL ?? 'http://localhost:8000/v1')

  // Keep ref in sync with state
  useEffect(() => {
    serversRef.current = servers
  }, [servers])

  const createClient = async (config: McpServerConfig): Promise<McpClient> => {
    const { transport } = await createTransport(config, credentialStoreRef.current, {
      cloudUrl: cloudUrlRef.current,
    })
    const client = await createMCPClient({ transport })
    // Store transport only after successful connection to avoid orphaned refs on failure
    transportRefs.current.set(config.id, transport)
    return client
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

  const disconnectServer = (serverId: string) => {
    const pendingRetry = retryTimeouts.current.get(serverId)
    if (pendingRetry) {
      clearTimeout(pendingRetry)
      retryTimeouts.current.delete(serverId)
    }

    const transport = transportRefs.current.get(serverId)
    if (transport) {
      transport.close()
      transportRefs.current.delete(serverId)
    }

    const client = clientRefs.current.get(serverId)
    if (client?.close) {
      client.close()
    }
    clientRefs.current.delete(serverId)
  }

  const addServer = async (server: McpServerConfig) => {
    setServers((prev) => [
      ...prev,
      {
        ...server,
        client: null,
        isConnected: false,
        error: null,
        errorMessage: null,
      },
    ])

    if (server.enabled) {
      await connectServer(server)
    }
  }

  const removeServer = (serverId: string) => {
    disconnectServer(serverId)
    credentialStoreRef.current.delete(serverId)
    setServers((prev) => prev.filter((s) => s.id !== serverId))
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
      setServers((prev) =>
        prev.map((s) =>
          s.id === serverId
            ? { ...s, client: null, isConnected: false, error: null, errorMessage: null, enabled: false }
            : s,
        ),
      )
    }
  }

  const reconnectServer = async (serverId: string) => {
    const server = serversRef.current.find((s) => s.id === serverId)
    if (!server) {
      return
    }

    disconnectServer(serverId)
    await connectServer(server, 0)
  }

  const getEnabledClients = (): McpClient[] =>
    serversRef.current
      .filter((server) => server.enabled && server.isConnected && server.client)
      .map((server) => server.client!)

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
