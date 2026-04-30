/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createMcpServer, deleteMcpServer, getHttpMcpServers } from '@/dal'
import { useDatabase } from '@/contexts'
import { mcpServersTable } from '@/db/tables'
import { useMcpSync } from '@/hooks/use-mcp-sync'
import { type McpServer } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { eq } from 'drizzle-orm'
import { Check, Copy, Globe, Plus, Server, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { createMCPClient } from '@ai-sdk/mcp'
import { createMcpTransport } from '@/lib/mcp-provider'
import { useProxyUrl } from '@/lib/proxy-url'
import { toCompilableQuery } from '@powersync/drizzle-driver'

type ServerTools = {
  [serverId: string]: string[]
}

export default function McpServersPage() {
  const db = useDatabase()
  const proxyUrl = useProxyUrl()
  const { servers: mcpServers } = useMcpSync()
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [newServerUrl, setNewServerUrl] = useState('')
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [serverCapabilities, setServerCapabilities] = useState<string[]>([])
  const [serverTools, setServerTools] = useState<ServerTools>({})
  const [selectedTools, setSelectedTools] = useState<{ [serverId: string]: { [tool: string]: boolean } }>({})
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRefs = useRef<{ [key: string]: HTMLElement | null }>({})

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

                // Initialize all tools as selected by default, but preserve existing selections
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

    // Only fetch if we have servers and mcpServers data
    if (servers.length > 0 && mcpServers.length > 0) {
      fetchServerTools()
    }
  }, [servers, mcpServers]) // Removed selectedTools from dependencies to avoid infinite loop

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
      setNewServerUrl('')
      setConnectionStatus('idle')
      setServerCapabilities([])
    },
  })

  const deleteServerMutation = useMutation({
    mutationFn: (id: string) => deleteMcpServer(db, id),
    onSuccess: () => {
      setDeleteConfirmOpen(null)
    },
  })

  const testConnection = async () => {
    if (!newServerUrl) {
      return
    }

    setIsTestingConnection(true)
    setConnectionStatus('idle')
    setServerCapabilities([])

    try {
      console.log('Testing connection to:', newServerUrl)

      // Create a real MCP client using the same method as the provider
      console.log('Creating MCP client...')
      const mcpClient = await createMCPClient({
        transport: createMcpTransport(newServerUrl, proxyUrl(newServerUrl)),
      })

      console.log('MCP client created successfully')

      // Try to get tools to verify the connection works
      console.log('Requesting tools...')
      const tools = await mcpClient.tools()

      console.log('Tools response:', tools)
      setConnectionStatus('success')

      // Extract tool names for display
      if (tools && typeof tools === 'object') {
        const toolNames = Object.keys(tools)
        setServerCapabilities(toolNames.length > 0 ? toolNames : ['Connection successful - no tools available'])
      } else {
        setServerCapabilities(['Connection successful - no tools listed'])
      }

      // Close the connection
      console.log('Closing MCP client connection...')
      if (mcpClient.close) {
        try {
          mcpClient.close()
        } catch (closeError) {
          console.warn('Error closing MCP client:', closeError)
        }
      }
    } catch (error) {
      console.error('Connection test error:', error)
      setConnectionStatus('error')
    } finally {
      setIsTestingConnection(false)
    }
  }

  const handleAddServer = () => {
    if (!newServerUrl) {
      return
    }

    // Extract server name from URL
    const url = new URL(newServerUrl)
    const name = `${url.hostname}${url.port ? `:${url.port}` : ''} MCP Server`

    addServerMutation.mutate({ name, url: newServerUrl })
  }

  const handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (connectionStatus === 'idle' && newServerUrl) {
        testConnection()
      } else if (connectionStatus === 'success') {
        handleAddServer()
      }
    }
  }

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current)
      }
      copiedTimerRef.current = setTimeout(() => setCopiedUrl(null), 2000)
    } catch (error) {
      console.error('Failed to copy URL:', error)
    }
  }

  const getConnectionStatus = (server: McpServer) => {
    // Get real connection status from MCP provider
    const mcpServer = mcpServers.find((s) => s.id === server.id)
    if (mcpServer) {
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
      default:
        return 'Unknown'
    }
  }

  const formatServerTitle = (url: string, serverId: string) => {
    try {
      const urlObj = new URL(url)
      // Remove protocol and query parameters, format without http/https
      const cleanUrl = `${urlObj.host}${urlObj.pathname.replace(/\/$/, '')}`

      // Check if the element would overflow by creating a temporary measurement
      const titleElement = titleRefs.current[serverId]
      if (titleElement) {
        const containerWidth = titleElement.parentElement?.offsetWidth || 0
        const switchWidth = 60 // Approximate width of switch + gap
        const availableWidth = containerWidth - switchWidth - 100 // Extra margin for safety

        // Create a temporary element to measure text width
        const tempElement = document.createElement('span')
        tempElement.style.visibility = 'hidden'
        tempElement.style.position = 'absolute'
        tempElement.style.fontSize = '18px' // text-lg
        tempElement.style.fontWeight = '500' // font-medium
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
      // Fallback for invalid URLs - remove common protocols
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

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <PageHeader title="MCP Servers">
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="icon" className="rounded-lg">
              <Plus />
            </Button>
          </DialogTrigger>
          <ResponsiveModalContentComposable className="sm:max-w-[500px]">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Add MCP Server</ResponsiveModalTitle>
              <ResponsiveModalDescription className="sr-only">Add a new MCP server</ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <div className="grid gap-4 pt-4 pb-2">
              <div className="grid gap-2">
                <Label htmlFor="url">Server URL</Label>
                <Input
                  id="url"
                  placeholder="http://localhost:8000/mcp/"
                  value={newServerUrl}
                  onChange={(e) => setNewServerUrl(e.target.value)}
                  onKeyDown={handleUrlKeyDown}
                />
              </div>

              {newServerUrl && (
                <Button onClick={testConnection} disabled={isTestingConnection} variant="outline" className="w-full">
                  {isTestingConnection ? 'Testing Connection...' : 'Test Connection'}
                </Button>
              )}

              {connectionStatus === 'success' && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2 text-green-800">
                    <Check className="h-4 w-4" />
                    <span className="font-medium">Connection successful!</span>
                  </div>
                  {serverCapabilities.length > 0 && (
                    <div className="mt-3">
                      <p className="text-sm text-green-700 font-medium">Available tools:</p>
                      <ul className="text-sm text-green-600 mt-1 space-y-1">
                        {serverCapabilities.map((capability, index) => (
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

              {connectionStatus === 'error' && (
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
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setIsAddDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAddServer} disabled={!newServerUrl || connectionStatus !== 'success'}>
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

          return (
            <Card key={server.id} className="border border-border">
              <CardHeader className="py-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <StatusIndicator status={status as 'connected' | 'connecting' | 'disconnected'} size="md" />
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
                              {formatServerTitle(server.url ?? '', server.id)}
                            </CardTitle>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-2" side="bottom" align="start">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-mono">{server.url}</p>
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
                            </div>
                          </PopoverContent>
                        </Popover>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Globe className="h-4 w-4 text-muted-foreground cursor-default" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            <p>Remote</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
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
              <Server className="size-10 text-muted-foreground mb-4" />
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
