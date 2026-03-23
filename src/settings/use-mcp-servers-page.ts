import { createMcpServer, deleteMcpServer, getAllMcpServers } from '@/dal'
import { isSupportedTransport, isCorsRestricted } from '@/lib/mcp-utils'
import { isTauri } from '@/lib/platform'
import { useMCP } from '@/lib/mcp-provider'
import { useDatabase } from '@/contexts'
import { mcpServersTable } from '@/db/tables'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import { useMcpServerFormState } from '@/hooks/use-mcp-server-form'
import type { McpTransportType } from '@/types/mcp'
import { type McpServer } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { eq } from 'drizzle-orm'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { createMCPClient } from '@ai-sdk/mcp'
import { toCompilableQuery } from '@powersync/drizzle-driver'

type ServerTools = {
  [serverId: string]: string[]
}

/**
 * Creates the appropriate MCP transport for connection testing, using dynamic
 * imports for Tauri transports to prevent crashes on web.
 */
const createTestTransport = async (
  transportType: 'http' | 'sse',
  url: URL,
  opts?: { requestInit: { headers: { Authorization: string } } },
) => {
  if (isTauri()) {
    if (transportType === 'sse') {
      const { createTauriSseTransport } = await import('@/lib/mcp-transports/tauri-sse-transport')
      return createTauriSseTransport(url, opts)
    }
    const { createTauriHttpTransport } = await import('@/lib/mcp-transports/tauri-http-transport')
    return createTauriHttpTransport(url, opts)
  }

  if (transportType === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(url, opts)
  }
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  return new StreamableHTTPClientTransport(url, opts)
}

export const useMcpServersPageState = () => {
  const db = useDatabase()
  const { servers: mcpServers } = useMcpSync()
  const { reconnectServer } = useMCP()
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [serverTools, setServerTools] = useState<ServerTools>({})
  const [selectedTools, setSelectedTools] = useState<{ [serverId: string]: { [tool: string]: boolean } }>({})
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const testAbortRef = useRef<AbortController | null>(null)
  const titleRefs = useRef<{ [key: string]: HTMLElement | null }>({})

  const { state: formState, dispatch: formDispatch, isValid } = useMcpServerFormState()

  const { data: servers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getAllMcpServers(db)),
  })

  const supportedServers = servers.filter((s) => isSupportedTransport((s.type ?? 'http') as McpTransportType))
  const hasUnsupportedServers = servers.length > supportedServers.length

  useEffect(() => {
    const fetchServerTools = async () => {
      const newServerTools: ServerTools = {}
      const newSelectedTools: { [serverId: string]: { [tool: string]: boolean } } = {}

      for (const server of servers) {
        if (server.enabled) {
          const mcpServer = mcpServers.find((s) => s.id === server.id)
          if (mcpServer?.isConnected && mcpServer.client) {
            try {
              const tools = await mcpServer.client.tools()
              if (tools && typeof tools === 'object') {
                const toolNames = Object.keys(tools)
                newServerTools[server.id] = toolNames

                if (!selectedTools[server.id]) {
                  newSelectedTools[server.id] = {}
                  toolNames.forEach((tool) => {
                    newSelectedTools[server.id][tool] = true
                  })
                }
              }
            } catch (error) {
              console.error('Failed to fetch tools for server:', server.name, error)
            }
          }
        }
      }

      setServerTools(newServerTools)
      if (Object.keys(newSelectedTools).length > 0) {
        setSelectedTools((prev) => ({ ...prev, ...newSelectedTools }))
      }
    }

    if (servers.length > 0 && mcpServers.length > 0) {
      fetchServerTools()
    }
    // selectedTools intentionally excluded — including it causes infinite loop
  }, [servers, mcpServers])

  useEffect(() => {
    if (copiedUrl) {
      const timer = setTimeout(() => setCopiedUrl(null), 2000)
      return () => clearTimeout(timer)
    }
  }, [copiedUrl])

  const toggleServerMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await db
        .update(mcpServersTable)
        .set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() })
        .where(eq(mcpServersTable.id, id))
    },
  })

  const addServerMutation = useMutation({
    mutationFn: async (server: {
      name: string
      type: 'http' | 'stdio' | 'sse'
      url?: string
      command?: string
      args?: string
      authType?: 'none' | 'bearer' | 'oauth'
    }) => {
      await createMcpServer(db, {
        id: uuidv7(),
        ...server,
        enabled: 1,
      })
    },
    onSuccess: () => {
      setIsAddDialogOpen(false)
      formDispatch({ type: 'RESET' })
    },
  })

  const deleteServerMutation = useMutation({
    mutationFn: (id: string) => deleteMcpServer(db, id),
    onSuccess: () => {
      setDeleteConfirmOpen(null)
    },
  })

  const testConnection = async () => {
    if (!isValid()) return

    testAbortRef.current?.abort()
    const abortController = new AbortController()
    testAbortRef.current = abortController

    formDispatch({ type: 'SET_CONNECTION_STATUS', payload: 'testing' })
    formDispatch({ type: 'SET_CONNECTION_ERROR', payload: null })
    formDispatch({ type: 'SET_CAPABILITIES', payload: [] })

    if (formState.transportType === 'stdio') {
      formDispatch({ type: 'SET_CONNECTION_STATUS', payload: 'success' })
      formDispatch({ type: 'SET_CAPABILITIES', payload: ['stdio transport — connection test not available yet'] })
      return
    }

    const TEST_TIMEOUT_MS = 15000
    let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null

    try {
      const url = new URL(formState.url)
      const opts =
        formState.authType === 'bearer' && formState.bearerToken
          ? { requestInit: { headers: { Authorization: `Bearer ${formState.bearerToken}` } } }
          : undefined
      const transport = await createTestTransport(formState.transportType as 'http' | 'sse', url, opts)

      const connectWithTimeout = async () => {
        const client = await createMCPClient({ transport })
        const tools = await client.tools()
        return { client, tools }
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out')), TEST_TIMEOUT_MS),
      )

      const { client, tools } = await Promise.race([connectWithTimeout(), timeoutPromise])
      mcpClient = client

      if (abortController.signal.aborted) return
      formDispatch({ type: 'SET_CONNECTION_STATUS', payload: 'success' })

      if (tools && typeof tools === 'object') {
        const toolNames = Object.keys(tools)
        formDispatch({
          type: 'SET_CAPABILITIES',
          payload: toolNames.length > 0 ? toolNames : ['Connection successful — no tools available'],
        })
      } else {
        formDispatch({ type: 'SET_CAPABILITIES', payload: ['Connection successful — no tools listed'] })
      }
    } catch {
      if (abortController.signal.aborted) return
      formDispatch({ type: 'SET_CONNECTION_STATUS', payload: 'error' })
      formDispatch({
        type: 'SET_CONNECTION_ERROR',
        payload: isCorsRestricted()
          ? 'Could not connect. Remote servers may be blocked by CORS. Localhost servers work without restriction.'
          : 'Could not connect to the MCP server. Please check the URL and try again.',
      })
    } finally {
      if (mcpClient?.close) {
        mcpClient.close()
      }
    }
  }

  const handleAddServer = () => {
    if (!isValid()) return

    const authType = formState.authType !== 'none' ? formState.authType : undefined

    if (formState.transportType === 'stdio') {
      const cleanArgs = formState.args.filter(Boolean)
      const name = `${formState.command} ${cleanArgs.join(' ')}`.trim()
      addServerMutation.mutate({
        name,
        type: 'stdio',
        command: formState.command,
        args: JSON.stringify(cleanArgs),
        authType,
      })
      return
    }

    const url = new URL(formState.url)
    const name = `${url.hostname}${url.port ? `:${url.port}` : ''} MCP Server`
    addServerMutation.mutate({ name, type: formState.transportType, url: formState.url, authType })
  }

  const handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (formState.connectionStatus === 'idle' && isValid()) {
      testConnection()
    } else if (formState.connectionStatus === 'success') {
      handleAddServer()
    }
  }

  const handleCopyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url)
    setCopiedUrl(url)
  }

  const handleArgsInput = (value: string) => {
    // Split on spaces but preserve trailing space so the user can type the next arg
    formDispatch({ type: 'SET_ARGS', payload: value.split(' ') })
  }

  const getConnectionStatus = (server: McpServer) => {
    const mcpServer = mcpServers.find((s) => s.id === server.id)
    if (mcpServer) {
      if (mcpServer.error) return 'error'
      if (mcpServer.isConnected) return 'connected'
      return mcpServer.enabled ? 'connecting' : 'disconnected'
    }
    return server.enabled ? 'connecting' : 'disconnected'
  }

  const getStatusTooltipText = (status: string) => {
    switch (status) {
      case 'connected':
        return 'Connected'
      case 'connecting':
        return 'Connecting...'
      case 'disconnected':
        return 'Disconnected'
      case 'error':
        return 'Connection error'
      default:
        return 'Unknown'
    }
  }

  const getServerErrorMessage = (server: McpServer) => {
    const mcpServer = mcpServers.find((s) => s.id === server.id)
    if (!mcpServer) return null
    return mcpServer.errorMessage ?? mcpServer.error?.message ?? null
  }

  const formatServerTitle = (url: string, serverId: string) => {
    try {
      const urlObj = new URL(url)
      const cleanUrl = `${urlObj.host}${urlObj.pathname.replace(/\/$/, '')}`

      const titleElement = titleRefs.current[serverId]
      if (titleElement) {
        const containerWidth = titleElement.parentElement?.offsetWidth || 0
        const switchWidth = 60
        const availableWidth = containerWidth - switchWidth - 100

        const tempElement = document.createElement('span')
        tempElement.style.visibility = 'hidden'
        tempElement.style.position = 'absolute'
        tempElement.style.fontSize = '18px'
        tempElement.style.fontWeight = '500'
        tempElement.textContent = cleanUrl
        document.body.appendChild(tempElement)

        const textWidth = tempElement.offsetWidth
        document.body.removeChild(tempElement)

        if (textWidth > availableWidth && cleanUrl.length > 30) {
          return cleanUrl.substring(0, 30) + '...'
        }
      }

      return cleanUrl
    } catch {
      const cleanUrl = url.replace(/^https?:\/\//, '')
      if (cleanUrl.length > 40) {
        return cleanUrl.substring(0, 37) + '...'
      }
      return cleanUrl
    }
  }

  const openAddDialog = () => setIsAddDialogOpen(true)
  const closeAddDialog = () => {
    testAbortRef.current?.abort()
    testAbortRef.current = null
    setIsAddDialogOpen(false)
    formDispatch({ type: 'RESET' })
  }

  const canTestConnection = isValid() && formState.connectionStatus !== 'testing'
  const canAddServer = isValid() && (formState.transportType === 'stdio' || formState.connectionStatus === 'success')

  return {
    supportedServers,
    hasUnsupportedServers,
    serverTools,
    selectedTools,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    copiedUrl,
    titleRefs,
    formState,
    formDispatch,
    isAddDialogOpen,
    openAddDialog,
    closeAddDialog,
    toggleServerMutation,
    addServerMutation,
    deleteServerMutation,
    testConnection,
    handleAddServer,
    handleUrlKeyDown,
    handleCopyUrl,
    handleArgsInput,
    getConnectionStatus,
    getStatusTooltipText,
    getServerErrorMessage,
    formatServerTitle,
    canTestConnection,
    canAddServer,
    isValid,
    reconnectServer,
  }
}
