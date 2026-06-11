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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { createMcpServerWithCredentials, deleteMcpServer, getRemoteMcpServers } from '@/dal'
import type { McpServerCredentials } from '@/dal/mcp-secrets'
import { useDatabase } from '@/contexts'
import { mcpSecretsTable, mcpServersTable } from '@/db/tables'
import { useMCP } from '@/lib/mcp-provider'
import { type McpServer } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { eq } from 'drizzle-orm'
import { Check, Copy, Globe, LockKeyhole, Plus, Server, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { probeMcpServerTools } from '@/lib/mcp-connection-test'
import { type MCPTransportType } from '@/lib/mcp-transport'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { getAuthToken } from '@/lib/auth-token'
import { computeEffectiveProxyEnabled, createProxyFetch } from '@/lib/proxy-fetch'
import { classifyMcpServerAuth } from '@/lib/mcp-auth/web-oauth-flow'
import type { completeMcpOAuthFlow, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import { McpOAuthNeedsReauthError } from '@/lib/mcp-auth/ensure-valid-token'
import { deriveOAuthCardDecision, type StoredCredentialType } from '@/lib/mcp-auth/auth-decision'
import { useMcpServerOAuth, type McpOAuthCallback, type OAuthCardState } from '@/hooks/use-mcp-server-oauth'
import { generateServerName, useAddServerForm } from '@/hooks/use-add-server-form'

export { generateServerName }

type ServerTools = {
  [serverId: string]: string[]
}

/**
 * True when an MCP connection error is the "token refresh failed, needs a fresh
 * authorization" signal. `defaultCreateClient` resolves the OAuth token BEFORE
 * constructing the client, so this error surfaces raw (un-wrapped) on the
 * provider's `server.error`.
 */
const isNeedsReauthError = (err: unknown): boolean => err instanceof McpOAuthNeedsReauthError

/**
 * Test-only DI seams. The Add-dialog Test Connection probe and OAuth flow
 * primitives are module imports in production; tests override them to exercise
 * the classification + Add & Authorize wiring without real network calls.
 */
export type McpServersPageDeps = {
  probeMcpServerTools?: typeof probeMcpServerTools
  classifyMcpServerAuth?: typeof classifyMcpServerAuth
  startMcpOAuthFlow?: typeof startMcpOAuthFlow
  completeMcpOAuthFlow?: typeof completeMcpOAuthFlow
}

export default function McpServersPage({ deps = {} }: { deps?: McpServersPageDeps } = {}) {
  const probeTools = deps.probeMcpServerTools ?? probeMcpServerTools
  const classifyAuth = deps.classifyMcpServerAuth ?? classifyMcpServerAuth
  const db = useDatabase()
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  // Read provider connection state read-only for status display. Sync ownership
  // lives in the single global useMcpSync() in AppContent — running it here too
  // would re-run the reconciliation effect and double-register servers.
  const { servers: mcpServers, reconnectServer } = useMCP()
  const location = useLocation()
  const navigate = useNavigate()
  const [serverTools, setServerTools] = useState<ServerTools>({})
  const [selectedTools, setSelectedTools] = useState<{ [serverId: string]: { [tool: string]: boolean } }>({})
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRefs = useRef<{ [key: string]: HTMLElement | null }>({})

  // Web OAuth discovery/exchange share the universal proxy fetch the transport
  // uses, so SSRF stays covered by `/v1/proxy` and the path matches production.
  const buildOAuthFetch = () =>
    createProxyFetch({
      cloudUrl,
      getProxyAuthToken: getAuthToken,
      getProxyEnabled: () => computeEffectiveProxyEnabled(),
    })

  const {
    cardStateFor,
    dialogError,
    clearDialogError,
    isAddAuthorizePending,
    startAuthorize,
    startAddAndAuthorize,
    processCallback,
  } = useMcpServerOAuth({
    db,
    buildOAuthFetch,
    reconnectServer,
    clearNavState: () => navigate('.', { replace: true, state: null }),
    startMcpOAuthFlow: deps.startMcpOAuthFlow,
    completeMcpOAuthFlow: deps.completeMcpOAuthFlow,
  })

  const form = useAddServerForm({
    cloudUrl,
    deps: { probeMcpServerTools: probeTools, classifyMcpServerAuth: classifyAuth, buildOAuthFetch },
    onClearDialogError: clearDialogError,
  })

  // TODO: Add support for stdio servers
  const { data: servers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getRemoteMcpServers(db)),
  })

  // Reactively track the STORED credential type per server so the card can apply
  // the auth precedence (oauth → authorized/needs-auth; bearer-401 → generic
  // error; none-401 → needs-auth). Reads the local-only mcp_secrets table.
  const { data: mcpSecrets = [] } = useQuery({
    queryKey: ['mcp-secrets'],
    query: toCompilableQuery(db.select().from(mcpSecretsTable)),
  })
  const credentialTypeById = mcpSecrets.reduce<Record<string, StoredCredentialType>>((acc, row) => {
    if (row.credentials) {
      acc[row.id] = (JSON.parse(row.credentials) as McpServerCredentials).type
    }
    return acc
  }, {})

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
    // The id is minted by the caller (not here) so an Add & Authorize retry can't
    // mint a fresh id and orphan a duplicate row when the flow fails and rolls back.
    mutationFn: async ({ id, name, url }: { id: string; name: string; url: string }) => {
      // OAuth servers have no credential here — they authorize post-create and
      // reconnect separately (see the Add & Authorize handler).
      await createMcpServerWithCredentials(
        db,
        { id, name, url, type: form.transport, enabled: 1 },
        form.token ? { type: 'bearer', token: form.token } : undefined,
      )
    },
  })

  const deleteServerMutation = useMutation({
    mutationFn: (id: string) => deleteMcpServer(db, id),
    onSuccess: () => {
      setDeleteConfirmOpen(null)
    },
  })

  const handleAddServer = async () => {
    if (!form.url) {
      return
    }
    await addServerMutation.mutateAsync({ id: uuidv7(), name: form.resolveServerName(), url: form.url })
    form.resetAddDialog()
  }

  /**
   * Empty-credential + OAuth-actionable path: hands the create-then-authorize to
   * the hook as one guarded operation (a caller-minted id keeps a retry from
   * duplicating the row, and the hook's re-entry guard makes a double-click /
   * Enter + click create only one row). On success the browser redirects to the
   * authorization server (the dialog leaves with the navigation); on failure the
   * hook rolls the row back and surfaces the error in the dialog. The created
   * server row also surfaces an Authorize action on its card.
   */
  const handleAddAndAuthorize = async () => {
    if (!form.url) {
      return
    }
    const url = form.url
    const id = uuidv7()
    const ok = await startAddAndAuthorize({
      serverId: id,
      serverUrl: url,
      createRow: () => addServerMutation.mutateAsync({ id, name: form.resolveServerName(), url }),
    })
    // Close the dialog once the flow started cleanly (web navigates away; mobile
    // opened the system browser; desktop completed inline). On failure it stays
    // open with the dialog error so the user can retry.
    if (ok) {
      form.resetAddDialog()
    }
  }

  const handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (form.testResult.kind === 'idle' && form.url) {
        form.testConnection()
      } else if (form.testResult.kind === 'success') {
        handleAddServer()
      } else if (form.testResult.kind === 'needs-oauth') {
        handleAddAndAuthorize()
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

  // Completes OAuth when navigated back from `/oauth/callback` with the code,
  // state and iss in `location.state`. Thin shim — the hook owns the handling.
  useEffect(() => {
    const oauth = (location.state as { oauth?: McpOAuthCallback } | null)?.oauth
    processCallback(oauth)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  /**
   * Resolves the visible OAuth state for a server: an explicit transient state
   * (authorizing/error/needs-auth) wins; otherwise it's derived by credential
   * precedence (`deriveOAuthCardDecision`) — `authorized` for a connected OAuth
   * server, `needs-auth` for an oauth/no-cred 401 or a failed refresh, and `null`
   * (generic connection error) for a rejected bearer token.
   */
  const getOAuthCardState = (server: McpServer): OAuthCardState | { phase: 'authorized' } | null => {
    const explicit = cardStateFor(server.id)
    if (explicit) {
      return explicit
    }
    const conn = mcpServers.find((s) => s.id === server.id)
    const decision = deriveOAuthCardDecision({
      isConnected: conn?.isConnected ?? false,
      credentialType: credentialTypeById[server.id] ?? 'none',
      error: conn?.error,
      needsReauth: isNeedsReauthError(conn?.error),
    })
    if (decision.phase === 'authorized') {
      return { phase: 'authorized' }
    }
    if (decision.phase === 'needs-auth') {
      return { phase: 'needs-auth' }
    }
    return null
  }

  return (
    <div className="flex flex-col gap-6 p-4 w-full max-w-[760px] mx-auto">
      <PageHeader title="MCP Servers">
        <Dialog
          open={form.isAddDialogOpen}
          onOpenChange={(open) => {
            if (open) {
              form.openDialog()
              return
            }
            // Closing (Escape / overlay / X) clears the form and cancels any
            // in-flight or pending probe, so nothing lands in the background.
            form.resetAddDialog()
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
              <ResponsiveModalDescription className="sr-only">Add a new MCP server</ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <div className="grid gap-4 pt-4 pb-2">
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  placeholder="Server name (used to prefix tools)"
                  value={form.name}
                  onChange={(e) => form.changeName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="url">Server URL</Label>
                <Input
                  id="url"
                  placeholder="http://localhost:8000/mcp/"
                  value={form.url}
                  onChange={(e) => form.changeUrl(e.target.value)}
                  onBlur={form.handleUrlBlur}
                  onKeyDown={handleUrlKeyDown}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="transport">Transport</Label>
                <Select
                  value={form.transport}
                  onValueChange={(value) => form.changeTransport(value as MCPTransportType)}
                >
                  <SelectTrigger id="transport" className="w-full rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="sse">SSE</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="token">Credential (optional)</Label>
                <Input
                  id="token"
                  type="password"
                  placeholder="Bearer token or API key"
                  value={form.token}
                  onChange={(e) => form.changeToken(e.target.value)}
                />
              </div>

              {form.url && (
                <Button
                  onClick={form.testConnection}
                  disabled={form.isTestingConnection}
                  variant="outline"
                  className="w-full"
                >
                  {form.isTestingConnection ? 'Testing Connection...' : 'Test Connection'}
                </Button>
              )}

              {form.testResult.kind === 'success' && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2 text-green-800">
                    <Check className="h-4 w-4" />
                    <span className="font-medium">Connection successful!</span>
                  </div>
                  {form.serverCapabilities.length > 0 && (
                    <div className="mt-3">
                      <p className="text-sm text-green-700 font-medium">Available tools:</p>
                      <ul className="text-sm text-green-600 mt-1 space-y-1 max-h-40 overflow-y-auto">
                        {form.serverCapabilities.map((capability, index) => (
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

              {form.testResult.kind === 'needs-oauth' && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-center gap-2 text-amber-800">
                    <LockKeyhole className="h-4 w-4" />
                    <span className="font-medium">Authorization required</span>
                  </div>
                  <p className="text-sm text-amber-700 mt-1">
                    This server uses OAuth. Add it and authorize to connect.
                  </p>
                </div>
              )}

              {form.testResult.kind === 'needs-token' && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-center gap-2 text-amber-800">
                    <LockKeyhole className="h-4 w-4" />
                    <span className="font-medium">Access token required</span>
                  </div>
                  <p className="text-sm text-amber-700 mt-1">
                    This server needs a personal access token or API key. Paste it in the Credential field above, then
                    test again.
                  </p>
                </div>
              )}

              {form.testResult.kind === 'token-rejected' && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-2 text-red-800">
                    <X className="h-4 w-4" />
                    <span className="font-medium">Token rejected</span>
                  </div>
                  <p className="text-sm text-red-600 mt-1">
                    The server rejected the credential — check your bearer token or API key.
                  </p>
                </div>
              )}

              {form.testResult.kind === 'error' && (
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

              {dialogError && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-2 text-red-800">
                    <X className="h-4 w-4" />
                    <span className="font-medium">Authorization error</span>
                  </div>
                  <p className="text-sm text-red-600 mt-1">{dialogError}</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={form.resetAddDialog}>
                Cancel
              </Button>
              {form.testResult.kind === 'needs-oauth' ? (
                <Button onClick={handleAddAndAuthorize} disabled={!form.url || isAddAuthorizePending}>
                  <LockKeyhole className="h-3.5 w-3.5 mr-1.5" />
                  Add &amp; Authorize
                </Button>
              ) : (
                <Button onClick={handleAddServer} disabled={!form.url || form.testResult.kind !== 'success'}>
                  Add Server
                </Button>
              )}
            </div>
          </ResponsiveModalContentComposable>
        </Dialog>
      </PageHeader>

      <div className="grid gap-4">
        {servers.map((server) => {
          const status = getConnectionStatus(server)
          const tools = serverTools[server.id] || []
          const isEnabled = server.enabled === 1
          const oauthState = getOAuthCardState(server)
          const isAuthorizing = oauthState?.phase === 'authorizing'
          const showAuthorize = oauthState?.phase === 'needs-auth' || oauthState?.phase === 'error'
          const isAuthorized = oauthState?.phase === 'authorized'

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
                    {(showAuthorize || isAuthorizing) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isAuthorizing}
                        onClick={() => startAuthorize(server)}
                      >
                        <LockKeyhole className="h-3.5 w-3.5 mr-1.5" />
                        {isAuthorizing ? 'Authorizing...' : 'Authorize'}
                      </Button>
                    )}
                    {isAuthorized && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="sm" onClick={() => startAuthorize(server)}>
                            <Check className="h-3.5 w-3.5 mr-1.5 text-green-600" />
                            Re-authorize
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          <p>Authorized — re-run the OAuth flow if access was revoked</p>
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
              {oauthState?.phase === 'needs-auth' && (
                <CardContent className="pt-0">
                  <p className="text-sm text-muted-foreground">
                    {oauthState.message ?? 'This server requires authorization. Click Authorize to connect.'}
                  </p>
                </CardContent>
              )}
              {oauthState?.phase === 'error' && (
                <CardContent className="pt-0">
                  <p className="text-sm text-red-600">{oauthState.message}</p>
                </CardContent>
              )}
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
              <Button onClick={form.openDialog} variant="outline">
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
