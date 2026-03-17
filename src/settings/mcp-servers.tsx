import { AvailableTools } from '@/components/available-tools'
import { StatusIndicator } from '@/components/status-indicator'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createMcpServer, deleteMcpServer, getHttpMcpServers } from '@/dal'
import { useDatabase } from '@/contexts'
import { mcpServersTable } from '@/db/tables'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import { useMcpServerFormState } from '@/hooks/use-mcp-server-form'
import type { McpTransportType, McpAuthType } from '@/types/mcp'
import { type McpServer } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { eq } from 'drizzle-orm'
import { Check, Copy, Globe, Key, Plus, RefreshCw, Terminal, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMCPClient } from '@ai-sdk/mcp'
import { toCompilableQuery } from '@powersync/drizzle-driver'

type ServerTools = {
  [serverId: string]: string[]
}

const transportLabel: Record<McpTransportType, string> = {
  http: 'HTTP',
  sse: 'SSE',
  stdio: 'stdio',
}

const TransportBadge = ({ type }: { type: McpTransportType }) => (
  <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
    {transportLabel[type]}
  </span>
)

const AuthBadge = ({ authType }: { authType: McpAuthType }) => {
  if (authType === 'none') return null
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
      <Key className="h-3 w-3" />
      {authType === 'bearer' ? 'Key' : 'OAuth'}
    </span>
  )
}

export default function McpServersPage() {
  const db = useDatabase()
  const { servers: mcpServers } = useMcpSync()
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [serverTools, setServerTools] = useState<ServerTools>({})
  const [selectedTools, setSelectedTools] = useState<{ [serverId: string]: { [tool: string]: boolean } }>({})
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const titleRefs = useRef<{ [key: string]: HTMLElement | null }>({})

  const { state: formState, dispatch: formDispatch, isValid } = useMcpServerFormState()

  // TODO: Add support for stdio servers
  const { data: servers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getHttpMcpServers(db)),
  })

  // Fetch tools for connected servers
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
  }, [servers, mcpServers]) // Removed selectedTools from dependencies to avoid infinite loop

  // Clear copied indication after 2 seconds
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
    mutationFn: async ({ name, url }: { name: string; url: string }) => {
      await createMcpServer(db, {
        id: uuidv7(),
        name,
        url,
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

    formDispatch({ type: 'SET_CONNECTION_STATUS', payload: 'testing' })
    formDispatch({ type: 'SET_CONNECTION_ERROR', payload: null })
    formDispatch({ type: 'SET_CAPABILITIES', payload: [] })

    if (formState.transportType === 'stdio') {
      // Validate-only for stdio until transport layer is available
      formDispatch({ type: 'SET_CONNECTION_STATUS', payload: 'success' })
      formDispatch({ type: 'SET_CAPABILITIES', payload: ['stdio transport — connection test not available yet'] })
      return
    }

    try {
      const mcpClient = await createMCPClient({
        transport: new StreamableHTTPClientTransport(new URL(formState.url), {
          requestInit: {
            headers: {
              Accept: 'application/json, text/event-stream',
            },
          },
        }),
      })

      const tools = await mcpClient.tools()

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

      if (mcpClient.close) {
        try {
          mcpClient.close()
        } catch {
          // ignore close errors
        }
      }
    } catch {
      formDispatch({ type: 'SET_CONNECTION_STATUS', payload: 'error' })
    }
  }

  const handleAddServer = () => {
    if (!isValid()) return

    if (formState.transportType === 'stdio') {
      // TODO: stub — stdio DAL support added in provider-integration phase
      console.warn('stdio server save is stubbed until DAL is updated')
      return
    }

    const url = new URL(formState.url)
    const name = `${url.hostname}${url.port ? `:${url.port}` : ''} MCP Server`
    addServerMutation.mutate({ name, url: formState.url })
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
    const args = value
      .split(' ')
      .map((a) => a.trim())
      .filter(Boolean)
    formDispatch({ type: 'SET_ARGS', payload: args })
  }

  const getConnectionStatus = (server: McpServer) => {
    const mcpServer = mcpServers.find((s) => s.id === server.id)
    if (mcpServer) {
      if (mcpServer.error) return 'error'
      return mcpServer.isConnected ? 'connected' : 'disconnected'
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
    // errorMessage is added in provider-integration; fall back to error.message for now
    return (mcpServer as unknown as { errorMessage?: string | null }).errorMessage ?? mcpServer.error?.message ?? null
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

  const handleDeleteServer = (serverId: string) => {
    deleteServerMutation.mutate(serverId)
  }

  const canTestConnection = isValid() && formState.connectionStatus !== 'testing'
  const canAddServer = isValid() && (formState.transportType === 'stdio' || formState.connectionStatus === 'success')

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
      <PageHeader title="MCP Servers">
        <Dialog
          open={isAddDialogOpen}
          onOpenChange={(open) => {
            setIsAddDialogOpen(open)
            if (!open) formDispatch({ type: 'RESET' })
          }}
        >
          <DialogTrigger asChild>
            <Button variant="outline" size="icon" className="rounded-lg">
              <Plus />
            </Button>
          </DialogTrigger>
          <ResponsiveModalContentComposable className="sm:max-w-[500px]">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Add MCP Server</ResponsiveModalTitle>
              <ResponsiveModalDescription>Configure the MCP server connection.</ResponsiveModalDescription>
            </ResponsiveModalHeader>

            <div className="grid gap-4 py-4">
              {/* Transport type selector */}
              <div className="grid gap-2">
                <Label htmlFor="transport-type">Transport</Label>
                <Select
                  value={formState.transportType}
                  onValueChange={(value) =>
                    formDispatch({ type: 'SET_TRANSPORT_TYPE', payload: value as McpTransportType })
                  }
                >
                  <SelectTrigger id="transport-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP (Streamable)</SelectItem>
                    <SelectItem value="sse">SSE (Legacy)</SelectItem>
                    <SelectItem value="stdio">stdio (Local)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* URL field for http/sse */}
              {formState.transportType !== 'stdio' && (
                <div className="grid gap-2">
                  <Label htmlFor="url">Server URL</Label>
                  <Input
                    id="url"
                    placeholder="http://localhost:8000/mcp/"
                    value={formState.url}
                    onChange={(e) => formDispatch({ type: 'SET_URL', payload: e.target.value })}
                    onKeyDown={handleUrlKeyDown}
                  />
                </div>
              )}

              {/* Command + args fields for stdio */}
              {formState.transportType === 'stdio' && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="command">Command</Label>
                    <Input
                      id="command"
                      placeholder="npx"
                      value={formState.command}
                      onChange={(e) => formDispatch({ type: 'SET_COMMAND', payload: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="args">Arguments (space-separated)</Label>
                    <Input
                      id="args"
                      placeholder="mcp-server --port 8080"
                      value={formState.args.join(' ')}
                      onChange={(e) => handleArgsInput(e.target.value)}
                    />
                  </div>
                </>
              )}

              {/* Authentication section */}
              <div className="grid gap-2">
                <Label htmlFor="auth-type">Authentication</Label>
                <Select
                  value={formState.authType}
                  onValueChange={(value) =>
                    formDispatch({ type: 'SET_AUTH_TYPE', payload: value as McpAuthType })
                  }
                >
                  <SelectTrigger id="auth-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="bearer">API Key / Bearer Token</SelectItem>
                    <SelectItem value="oauth">OAuth 2.1</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {formState.authType === 'bearer' && (
                <div className="grid gap-2">
                  <Label htmlFor="bearer-token">API Key / Bearer Token</Label>
                  <Input
                    id="bearer-token"
                    type="password"
                    autoComplete="off"
                    placeholder="Enter API key or bearer token"
                    value={formState.bearerToken}
                    onChange={(e) => formDispatch({ type: 'SET_BEARER_TOKEN', payload: e.target.value })}
                  />
                </div>
              )}

              {formState.authType === 'oauth' && (
                <div className="grid gap-2">
                  <Button variant="outline" className="w-full" disabled>
                    Connect with OAuth
                    <span className="ml-2 text-xs text-muted-foreground">(coming soon)</span>
                  </Button>
                </div>
              )}

              {/* Test connection button */}
              {formState.transportType !== 'stdio' && isValid() && (
                <Button
                  onClick={testConnection}
                  disabled={!canTestConnection}
                  variant="outline"
                  className="w-full"
                >
                  {formState.connectionStatus === 'testing' ? 'Testing Connection...' : 'Test Connection'}
                </Button>
              )}

              {/* Connection success */}
              {formState.connectionStatus === 'success' && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2 text-green-800">
                    <Check className="h-4 w-4" />
                    <span className="font-medium">Connection successful!</span>
                  </div>
                  {formState.serverCapabilities.length > 0 && (
                    <div className="mt-3">
                      <p className="text-sm text-green-700 font-medium">Available tools:</p>
                      <ul className="text-sm text-green-600 mt-1 space-y-1">
                        {formState.serverCapabilities.map((capability, index) => (
                          <li key={index} className="flex items-center gap-2">
                            <div className="w-1 h-1 bg-green-600 rounded-full" />
                            {capability}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Connection error */}
              {formState.connectionStatus === 'error' && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-2 text-red-800">
                    <X className="h-4 w-4" />
                    <span className="font-medium">Connection failed</span>
                  </div>
                  <p className="text-sm text-red-600 mt-1">
                    Could not connect to the MCP server. Please check the URL and try again.
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAddServer} disabled={!canAddServer}>
                Add Server
              </Button>
            </div>
          </ResponsiveModalContentComposable>
        </Dialog>
      </PageHeader>

      <div className="grid gap-4">
        {servers.map((server) => {
          const status = getConnectionStatus(server)
          const tools = serverTools[server.id] || []
          const isEnabled = server.enabled === 1
          const errorMessage = getServerErrorMessage(server)
          const serverTransport = server.type ?? 'http'
          const serverAuthType: McpAuthType = (server.authType ?? 'none') as McpAuthType

          return (
            <Card key={server.id} className="border border-border shadow-sm">
              <CardHeader className="py-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <StatusIndicator
                            status={status as 'connected' | 'connecting' | 'disconnected'}
                            size="md"
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>{getStatusTooltipText(status)}</p>
                      </TooltipContent>
                    </Tooltip>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Popover>
                          <PopoverTrigger asChild>
                            <CardTitle
                              ref={(el) => {
                                titleRefs.current[server.id] = el
                              }}
                              className="text-lg font-medium cursor-pointer"
                            >
                              {formatServerTitle(server.url ?? server.command ?? '', server.id)}
                            </CardTitle>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-2" side="bottom" align="start">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-mono">{server.url ?? server.command}</p>
                              {server.url && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0 hover:bg-muted"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleCopyUrl(server.url ?? '')
                                  }}
                                  disabled={copiedUrl === server.url}
                                >
                                  {copiedUrl === server.url ? (
                                    <Check className="h-3 w-3 text-muted-foreground" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </Button>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div>
                              {serverTransport === 'stdio' ? (
                                <Terminal className="h-4 w-4 text-muted-foreground cursor-default" />
                              ) : (
                                <Globe className="h-4 w-4 text-muted-foreground cursor-default" />
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p>{serverTransport === 'stdio' ? 'Local (stdio)' : 'Remote'}</p>
                          </TooltipContent>
                        </Tooltip>
                        <TransportBadge type={serverTransport as McpTransportType} />
                        <AuthBadge authType={serverAuthType} />
                      </div>
                      {status === 'error' && errorMessage && (
                        <p className="text-xs text-destructive mt-0.5 truncate max-w-xs">{errorMessage}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {status === 'error' && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => {
                              const mcpServer = mcpServers.find((s) => s.id === server.id)
                              if (mcpServer) {
                                // reconnect is wired in provider-integration phase
                                console.log('retry connection for', server.id)
                              }
                            }}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          <p>Retry connection</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={(checked) =>
                              toggleServerMutation.mutate({ id: server.id, enabled: checked })
                            }
                            className="cursor-pointer"
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>{isEnabled ? 'Disable server' : 'Enable server'}</p>
                      </TooltipContent>
                    </Tooltip>
                    <Popover
                      open={deleteConfirmOpen === server.id}
                      onOpenChange={(open) => setDeleteConfirmOpen(open ? server.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-80" side="bottom" align="end">
                        <div className="space-y-3">
                          <div>
                            <h4 className="font-medium">Remove Server</h4>
                            <p className="text-sm text-muted-foreground">
                              Are you sure you want to remove this MCP server? This action cannot be undone.
                            </p>
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmOpen(null)}>
                              Cancel
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => handleDeleteServer(server.id)}>
                              Remove
                            </Button>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </CardHeader>
              {isEnabled && tools.length > 0 && (
                <CardContent className="pt-0 border-t">
                  <AvailableTools
                    className="pt-4"
                    tools={tools.map((tool) => ({
                      name: tool,
                      enabled: selectedTools[server.id]?.[tool] ?? true,
                    }))}
                  />
                </CardContent>
              )}
            </Card>
          )
        })}

        {servers.length === 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Plus className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium text-foreground mb-1">No MCP servers configured</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Get started by adding your first MCP server connection.
              </p>
              <Button onClick={() => setIsAddDialogOpen(true)} variant="outline">
                <Plus className="h-4 w-4 mr-2" />
                Add Server
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
