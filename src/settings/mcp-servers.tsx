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
import { createMcpServer, deleteMcpServer, getRemoteMcpServers, setMcpServerCredentials } from '@/dal'
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
import { createMCPClient } from '@ai-sdk/mcp'
import { buildMcpHeaders, createMcpTransport, type MCPTransportType } from '@/lib/mcp-transport'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { getAuthToken } from '@/lib/auth-token'
import { isUnauthorizedError } from '@/lib/mcp-errors'
import { computeEffectiveProxyEnabled, createProxyFetch } from '@/lib/proxy-fetch'
import { setOAuthState } from '@/lib/oauth-state'
import { completeMcpOAuthFlow, isOAuthServer, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import { clearMcpOAuthState, getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { McpOAuthNeedsReauthError } from '@/lib/mcp-auth/ensure-valid-token'
import {
  decideTestConnectionResult,
  deriveOAuthCardDecision,
  type StoredCredentialType,
  type TestConnectionResult,
} from '@/lib/mcp-auth/auth-decision'

type ServerTools = {
  [serverId: string]: string[]
}

/**
 * Per-server OAuth UI state. `needs-auth` / `authorized` are derived from the
 * live connection + stored credentials; `authorizing` / `error` are transient
 * states the page sets while a flow runs or fails.
 */
type OAuthCardState =
  | { phase: 'authorizing' }
  | { phase: 'error'; message: string }
  | { phase: 'needs-auth'; message?: string }

/**
 * True when an MCP connection error is the M3 "token refresh failed, needs a
 * fresh authorization" signal. `defaultCreateClient` resolves the OAuth token
 * BEFORE constructing the client, so this error surfaces raw (un-wrapped) on the
 * provider's `server.error`.
 */
const isNeedsReauthError = (err: unknown): boolean => err instanceof McpOAuthNeedsReauthError

/** Maps a raw OAuth `error` query value to a short, user-facing message. */
const friendlyOAuthError = (error?: string): string => {
  if (error === 'access_denied') {
    return 'Authorization was declined.'
  }
  return 'Authorization failed. Please try again.'
}

/**
 * Derives a short, meaningful server name from a remote MCP URL — used to
 * pre-fill (and re-derive) the editable name field. The name namespaces the
 * server's tools in the prompt, so a readable default like `github` or `render`
 * beats the raw hostname.
 * - Localhost: includes port for disambiguation (`localhost-3000`)
 * - IP literals (IPv4 dotted-quad or IPv6): kept whole so distinct hosts stay
 *   distinct (`192.168.1.100`, `2001:db8::1`)
 * - Remote: 3+ domain segments → second-to-last (`api.github.com` → `github`);
 *   2 segments → first (`render.com` → `render`); 1 → as-is
 */
export const generateServerName = (url: string): string => {
  try {
    const { hostname, port } = new URL(url)
    // `URL` brackets IPv6 hosts (`[::1]`) and may keep a trailing FQDN dot — normalize both.
    const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return port ? `localhost-${port}` : 'localhost'
    }
    // IP literals (IPv4 dotted-quad or IPv6) have no registrable label to shorten to —
    // use the whole address so distinct hosts stay distinct (sanitizeToolPrefix maps separators to `_`).
    if (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return host
    }
    const parts = host.split('.')
    return parts.length >= 3 ? parts[parts.length - 2] : parts[0]
  } catch {
    return ''
  }
}

export default function McpServersPage() {
  const db = useDatabase()
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  // Read provider connection state read-only for status display. Sync ownership
  // lives in the single global useMcpSync() in AppContent — running it here too
  // would re-run the reconciliation effect and double-register servers.
  const { servers: mcpServers, reconnectServer } = useMCP()
  const location = useLocation()
  const navigate = useNavigate()
  const [oauthCardState, setOauthCardState] = useState<Record<string, OAuthCardState>>({})
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [newServerName, setNewServerName] = useState('')
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false)
  const [newServerUrl, setNewServerUrl] = useState('')
  const [newServerTransport, setNewServerTransport] = useState<MCPTransportType>('http')
  const [newServerToken, setNewServerToken] = useState('')
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | { kind: 'idle' }>({ kind: 'idle' })
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
    mutationFn: async ({ name, url }: { name: string; url: string }): Promise<string> => {
      const id = uuidv7()
      // Persist credentials BEFORE the server row. useMcpSync reacts to the new
      // mcp_servers row and the provider connects by reading credentials from the
      // DB at connect time — if the token isn't stored yet the first connect is
      // unauthenticated and nothing reconnects it. Writing the secret first
      // (keyed by the same id) guarantees the connect sees the token. (OAuth has
      // no token here — it authorizes post-create and reconnects separately.)
      if (newServerToken) {
        await setMcpServerCredentials(db, id, { type: 'bearer', token: newServerToken })
      }
      await createMcpServer(db, {
        id,
        name,
        url,
        type: newServerTransport,
        enabled: 1,
      })
      return id
    },
    onSuccess: () => {
      setIsAddDialogOpen(false)
      setNewServerName('')
      setNameManuallyEdited(false)
      setNewServerUrl('')
      setNewServerTransport('http')
      setNewServerToken('')
      setTestResult({ kind: 'idle' })
      setServerCapabilities([])
    },
  })

  const deleteServerMutation = useMutation({
    mutationFn: (id: string) => deleteMcpServer(db, id),
    onSuccess: () => {
      setDeleteConfirmOpen(null)
    },
  })

  // Editing any field after a test invalidates that result, so the user can't
  // add a url+transport+token combination that was never tested together. The
  // idle guard avoids re-rendering on every keystroke once already cleared.
  const resetConnectionTest = () => {
    if (testResult.kind === 'idle') {
      return
    }
    setTestResult({ kind: 'idle' })
    setServerCapabilities([])
  }

  const testConnection = async () => {
    if (!newServerUrl) {
      return
    }

    setIsTestingConnection(true)
    setTestResult({ kind: 'idle' })
    setServerCapabilities([])

    try {
      // Create a real MCP client using the same method as the provider —
      // route through the universal proxy so the test matches the real
      // connection path (web CORS would otherwise fail for remote servers).
      const headers = buildMcpHeaders(newServerToken || undefined)
      const transport = createMcpTransport(newServerUrl, newServerTransport, cloudUrl, headers)
      const mcpClient = await createMCPClient({ transport })

      // Try to get tools to verify the connection works
      const tools = await mcpClient.tools()

      const toolNames = tools && typeof tools === 'object' ? Object.keys(tools) : []
      setTestResult({ kind: 'success', tools: toolNames })
      setServerCapabilities(toolNames.length > 0 ? toolNames : ['Connection successful - no tools available'])

      // Close the connection
      if (mcpClient.close) {
        try {
          mcpClient.close()
        } catch (closeError) {
          console.warn('Error closing MCP client:', closeError)
        }
      }
    } catch (error) {
      console.error('Connection test error:', error)
      // Auth precedence: a supplied credential that 401s is a rejected token
      // (no Authorize). An empty-credential 401 runs OAuth discovery — offer
      // "Add & Authorize" only when protected-resource metadata is discoverable.
      const oauthDiscoverable =
        !newServerToken && isUnauthorizedError(error) ? await isOAuthServer(newServerUrl, buildOAuthFetch()) : false
      setTestResult(decideTestConnectionResult({ hasCredential: !!newServerToken, error, oauthDiscoverable }))
    } finally {
      setIsTestingConnection(false)
    }
  }

  // Name prefixes the server's tools in the prompt. Use the user's name when
  // set, otherwise fall back to the value derived from the URL.
  const resolveServerName = () => newServerName.trim() || generateServerName(newServerUrl)

  const handleAddServer = () => {
    if (!newServerUrl) {
      return
    }
    addServerMutation.mutate({ name: resolveServerName(), url: newServerUrl })
  }

  /**
   * Empty-credential + OAuth-discoverable path: add the server, then kick off the
   * web OAuth flow for the freshly-created id. The redirect happens inside
   * `handleAuthorize`, so the dialog closes (via `addServerMutation.onSuccess`)
   * and the browser leaves for the authorization server.
   */
  const handleAddAndAuthorize = async () => {
    if (!newServerUrl) {
      return
    }
    const url = newServerUrl
    const id = await addServerMutation.mutateAsync({ name: resolveServerName(), url })
    await handleAuthorize({ id, url } as McpServer)
  }

  const handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (testResult.kind === 'idle' && newServerUrl) {
        testConnection()
      } else if (testResult.kind === 'success') {
        handleAddServer()
      } else if (testResult.kind === 'needs-oauth') {
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

  // Web OAuth discovery/exchange share the universal proxy fetch the transport
  // uses, so SSRF stays covered by `/v1/proxy` and the path matches production.
  const buildOAuthFetch = () =>
    createProxyFetch({
      cloudUrl,
      getProxyAuthToken: getAuthToken,
      getProxyEnabled: () => computeEffectiveProxyEnabled(),
    })

  /**
   * Begins (or restarts) the OAuth flow for a server: discovers the AS,
   * registers, builds the PKCE authorize URL, persists the handshake, and
   * redirects the browser. Records the return path so `OAuthCallback` navigates
   * back here with the code/state/iss.
   */
  const handleAuthorize = async (server: McpServer) => {
    setOauthCardState((prev) => ({ ...prev, [server.id]: { phase: 'authorizing' } }))
    setOAuthState({ returnContext: '/settings/mcp-servers' })
    try {
      await startMcpOAuthFlow({
        db,
        serverId: server.id,
        serverUrl: server.url ?? '',
        fetchFn: buildOAuthFetch(),
      })
      // On success the browser navigates away; nothing more to do here.
    } catch (error) {
      console.error('Failed to start MCP OAuth flow:', error)
      setOauthCardState((prev) => ({
        ...prev,
        [server.id]: { phase: 'error', message: 'Could not start authorization. Please try again.' },
      }))
    }
  }

  // Completes OAuth when navigated back from `/oauth/callback` with the code,
  // state and iss in `location.state` (mirrors the integrations callback handler).
  useEffect(() => {
    const oauth = (location.state as { oauth?: { code?: string; state?: string; iss?: string; error?: string } } | null)
      ?.oauth
    if (!oauth) {
      return
    }

    const handleCallback = async () => {
      const { serverId } = getMcpOAuthState()
      // Always clear the navigation state so a refresh can't reprocess the callback.
      navigate('.', { replace: true, state: null })
      if (!serverId) {
        return
      }

      if (oauth.error) {
        setOauthCardState((prev) => ({
          ...prev,
          [serverId]: { phase: 'error', message: friendlyOAuthError(oauth.error) },
        }))
        clearMcpOAuthState()
        return
      }

      if (!oauth.code) {
        setOauthCardState((prev) => ({
          ...prev,
          [serverId]: { phase: 'error', message: 'Authorization was cancelled.' },
        }))
        clearMcpOAuthState()
        return
      }

      setOauthCardState((prev) => ({ ...prev, [serverId]: { phase: 'authorizing' } }))
      try {
        await completeMcpOAuthFlow({
          db,
          serverId,
          code: oauth.code,
          returnedState: oauth.state,
          returnedIss: oauth.iss,
          fetchFn: buildOAuthFetch(),
        })
        setOauthCardState((prev) => {
          const next = { ...prev }
          delete next[serverId]
          return next
        })
        await reconnectServer(serverId)
      } catch (error) {
        console.error('Failed to complete MCP OAuth flow:', error)
        setOauthCardState((prev) => ({
          ...prev,
          [serverId]: { phase: 'error', message: error instanceof Error ? error.message : 'Authorization failed.' },
        }))
      }
    }

    handleCallback()
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
    const explicit = oauthCardState[server.id]
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
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  placeholder="Server name (used to prefix tools)"
                  value={newServerName}
                  onChange={(e) => {
                    resetConnectionTest()
                    setNewServerName(e.target.value)
                    setNameManuallyEdited(true)
                  }}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="url">Server URL</Label>
                <Input
                  id="url"
                  placeholder="http://localhost:8000/mcp/"
                  value={newServerUrl}
                  onChange={(e) => {
                    resetConnectionTest()
                    setNewServerUrl(e.target.value)
                    if (!nameManuallyEdited) {
                      setNewServerName(generateServerName(e.target.value))
                    }
                  }}
                  onKeyDown={handleUrlKeyDown}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="transport">Transport</Label>
                <Select
                  value={newServerTransport}
                  onValueChange={(value) => {
                    resetConnectionTest()
                    setNewServerTransport(value as MCPTransportType)
                  }}
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
                  value={newServerToken}
                  onChange={(e) => {
                    resetConnectionTest()
                    setNewServerToken(e.target.value)
                  }}
                />
              </div>

              {newServerUrl && (
                <Button onClick={testConnection} disabled={isTestingConnection} variant="outline" className="w-full">
                  {isTestingConnection ? 'Testing Connection...' : 'Test Connection'}
                </Button>
              )}

              {testResult.kind === 'success' && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2 text-green-800">
                    <Check className="h-4 w-4" />
                    <span className="font-medium">Connection successful!</span>
                  </div>
                  {serverCapabilities.length > 0 && (
                    <div className="mt-3">
                      <p className="text-sm text-green-700 font-medium">Available tools:</p>
                      <ul className="text-sm text-green-600 mt-1 space-y-1 max-h-40 overflow-y-auto">
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

              {testResult.kind === 'needs-oauth' && (
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

              {testResult.kind === 'token-rejected' && (
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

              {testResult.kind === 'error' && (
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
              {testResult.kind === 'needs-oauth' ? (
                <Button onClick={handleAddAndAuthorize} disabled={!newServerUrl}>
                  <LockKeyhole className="h-3.5 w-3.5 mr-1.5" />
                  Add &amp; Authorize
                </Button>
              ) : (
                <Button onClick={handleAddServer} disabled={!newServerUrl || testResult.kind !== 'success'}>
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
                        onClick={() => handleAuthorize(server)}
                      >
                        <LockKeyhole className="h-3.5 w-3.5 mr-1.5" />
                        {isAuthorizing ? 'Authorizing...' : 'Authorize'}
                      </Button>
                    )}
                    {isAuthorized && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="sm" onClick={() => handleAuthorize(server)}>
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
