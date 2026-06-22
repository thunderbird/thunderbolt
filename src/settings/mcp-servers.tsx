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
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  createMcpServersWithCredentials,
  createMcpServerWithCredentials,
  deleteMcpServer,
  getRemoteMcpServers,
  updateMcpServerWithCredentials,
} from '@/dal'
import type { McpServerCredentials } from '@/dal/mcp-secrets'
import { useDatabase } from '@/contexts'
import { mcpSecretsTable, mcpServersTable } from '@/db/tables'
import { useMCP, type MCPClient } from '@/lib/mcp-provider'
import { type McpServer } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { eq } from 'drizzle-orm'
import { Check, Copy, Globe, LockKeyhole, Pencil, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
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
import {
  deriveOAuthCardDecision,
  type StoredCredentialType,
  type TestConnectionResult,
} from '@/lib/mcp-auth/auth-decision'
import { parseMcpServersConfig, type ParsedMcpServer } from '@/lib/mcp-config-import'
import { validateMcpServerUrl } from '@/lib/mcp-url-validation'
import { useMcpServerOAuth, type McpOAuthCallback, type OAuthCardState } from '@/hooks/use-mcp-server-oauth'
import { generateServerName, useAddServerForm } from '@/hooks/use-add-server-form'

export { generateServerName }

type ServerTools = {
  [serverId: string]: string[]
}

/**
 * Monotonic identity tag for an MCP client instance. A successful reconnect
 * (Retry connection, OAuth re-authorize) swaps the client object without
 * changing the server id, so the tools query keys on `id:generation` to detect
 * the swap and refetch. The WeakMap hands every new instance a fresh generation
 * while keeping replaced clients collectable.
 */
let nextClientGeneration = 0
const clientGenerations = new WeakMap<MCPClient, number>()
const clientGenerationOf = (client: MCPClient): number => {
  const existing = clientGenerations.get(client)
  if (existing !== undefined) {
    return existing
  }
  nextClientGeneration += 1
  clientGenerations.set(client, nextClientGeneration)
  return nextClientGeneration
}

/** Add-dialog mode: a single guided server form, or a raw JSON config paste. */
type AddServerMode = 'simple' | 'advanced'

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

type StatusTone = 'success' | 'warning' | 'destructive'

/**
 * Tone → full literal class strings. Tailwind v4's JIT scanner only sees static
 * class names, so the tone must NEVER be interpolated into a class string —
 * `bg-${tone}/10` would not be generated. Look the literals up here instead.
 */
const toneClasses: Record<StatusTone, { box: string; title: string; body: string }> = {
  success: { box: 'bg-success/10 border-success/30', title: 'text-success', body: 'text-success/90' },
  warning: { box: 'bg-warning/10 border-warning/30', title: 'text-warning', body: 'text-warning/90' },
  destructive: {
    box: 'bg-destructive/10 border-destructive/30',
    title: 'text-destructive',
    body: 'text-destructive/90',
  },
}

/** A toned status box (icon + bold title row) used by the add-dialog result panels. */
const StatusPanel = ({
  tone,
  icon,
  title,
  children,
}: {
  tone: StatusTone
  icon: ReactNode
  title: string
  children?: ReactNode
}) => {
  const classes = toneClasses[tone]
  return (
    <div className={`p-4 border rounded-lg ${classes.box}`}>
      <div className={`flex items-center gap-2 ${classes.title}`}>
        {icon}
        <span className="font-medium">{title}</span>
      </div>
      {children}
    </div>
  )
}

/**
 * The non-success test-result panels are pure data — each maps a result `kind`
 * to its tone, icon, title, and body copy. `success` is rendered separately
 * because it carries a tools list as the panel's children.
 */
const testResultPanels: Record<
  Exclude<TestConnectionResult['kind'], 'success'>,
  { tone: StatusTone; icon: ReactNode; title: string; body: string }
> = {
  'needs-oauth': {
    tone: 'warning',
    icon: <LockKeyhole className="h-4 w-4" />,
    title: 'Authorization required',
    body: 'This server uses OAuth. Add it and authorize to connect.',
  },
  'needs-token': {
    tone: 'warning',
    icon: <LockKeyhole className="h-4 w-4" />,
    title: 'Access token required',
    body: 'This server needs a personal access token or API key. Paste it in the Credential field above, then test again.',
  },
  'token-rejected': {
    tone: 'destructive',
    icon: <X className="h-4 w-4" />,
    title: 'Token rejected',
    body: 'The server rejected the credential — check your bearer token or API key.',
  },
  error: {
    tone: 'destructive',
    icon: <X className="h-4 w-4" />,
    title: 'Connection failed',
    body: 'Could not connect to the MCP server. Please check the URL and try again.',
  },
}

export default function McpServersPage({ deps = {} }: { deps?: McpServersPageDeps } = {}) {
  const probeTools = deps.probeMcpServerTools ?? probeMcpServerTools
  const classifyAuth = deps.classifyMcpServerAuth ?? classifyMcpServerAuth
  const db = useDatabase()
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  // Read provider connection state read-only for status display. Sync ownership
  // lives in the single global useMcpSync() in AppContent — running it here too
  // would re-run the reconciliation effect and double-register servers.
  const { servers: mcpServers, reconnectServer, updateServer } = useMCP()
  const location = useLocation()
  const navigate = useNavigate()
  const [mode, setMode] = useState<AddServerMode>('simple')
  const [jsonText, setJsonText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [retryingServerId, setRetryingServerId] = useState<string | null>(null)
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

  const {
    name: newServerName,
    url: newServerUrl,
    transport: newServerTransport,
    token: newServerToken,
    testResult,
    isTestingConnection,
    serverCapabilities,
    resolveServerName,
    testConnection,
    handleUrlBlur,
  } = form
  // In simple mode the URL gates auto-detect / Add; advanced mode imports raw JSON.
  const urlValidation = newServerUrl ? validateMcpServerUrl(newServerUrl) : null
  const isUrlValid = urlValidation?.ok === true

  // The add-dialog surfaces at most one error: a JSON import failure (advanced) or
  // an OAuth authorization failure (simple). The title is derived from the error
  // itself — not the current mode — so a message is always labeled by its own
  // context (switching modes clears the other source, see the mode toggle).
  const addDialogError = importError
    ? { title: 'Import failed', body: importError }
    : dialogError
      ? { title: 'Authorization error', body: dialogError }
      : null

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

  // Prefill source for Edit: the on-device bearer token (if the stored credential
  // is bearer). OAuth credentials are intentionally not surfaced — the token UI
  // only accepts bearer values, and OAuth is managed via the Authorize buttons.
  const bearerTokenById = mcpSecrets.reduce<Record<string, string>>((acc, row) => {
    if (row.credentials) {
      const cred = JSON.parse(row.credentials) as McpServerCredentials
      if (cred.type === 'bearer') {
        acc[row.id] = cred.token
      }
    }
    return acc
  }, {})

  // Tools for connected servers. The query keys on each CONNECTION's identity
  // (`id:generation`, where the generation changes whenever the provider swaps in
  // a fresh client instance) — keying on the id set alone would serve the dead
  // client's cached tools after a reconnect that doesn't change the set. Each
  // client's tools() is fetched in parallel; failures degrade to an empty list
  // rather than rejecting the query.
  const connectedServers = mcpServers
    .flatMap((s) => (s.isConnected && s.client ? [{ id: s.id, client: s.client }] : []))
    .sort((a, b) => a.id.localeCompare(b.id))
  const { data: serverTools = {} } = useQuery<ServerTools>({
    queryKey: ['mcp-server-tools', connectedServers.map(({ id, client }) => `${id}:${clientGenerationOf(client)}`)],
    enabled: connectedServers.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        connectedServers.map(async ({ id, client }): Promise<[string, string[]]> => {
          try {
            const tools = await client.tools()
            return [id, tools && typeof tools === 'object' ? Object.keys(tools) : []]
          } catch (error) {
            console.error('Failed to fetch tools for server:', id, error)
            return [id, []]
          }
        }),
      )
      return Object.fromEntries(entries)
    },
  })

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

  const updateServerMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      url,
      transport,
      token,
      originalCredentialType,
    }: {
      id: string
      name: string
      url: string
      transport: MCPTransportType
      token: string
      originalCredentialType: StoredCredentialType
    }) => {
      // Credential semantics on edit:
      //   - token filled → store as bearer (replaces any prior credential, OAuth included)
      //   - token blank + originally bearer → delete the credential (user cleared the field)
      //   - token blank + originally oauth/none → leave the credential alone, so a rename
      //     of an OAuth-authorized server doesn't wipe its tokens
      const credentials = token
        ? ({ type: 'bearer', token } as const)
        : originalCredentialType === 'bearer'
          ? null
          : undefined
      await updateMcpServerWithCredentials(db, id, { name, url, type: transport }, credentials)
    },
  })

  const importServersMutation = useMutation({
    mutationFn: async (parsed: ParsedMcpServer[]): Promise<void> => {
      await createMcpServersWithCredentials(
        db,
        parsed.map((server) => ({
          server: {
            id: uuidv7(),
            name: server.name,
            url: server.url,
            type: server.transport,
            enabled: server.enabled ? 1 : 0,
          },
          credential: server.credential,
        })),
      )
    },
  })

  const deleteServerMutation = useMutation({
    mutationFn: (id: string) => deleteMcpServer(db, id),
    onSuccess: () => {
      setDeleteConfirmOpen(null)
    },
  })

  // Clears add-dialog local state (mode, JSON text, import error) in sync with
  // the external form hook's resetAddDialog so a re-open always starts clean.
  const resetLocalDialogState = () => {
    setMode('simple')
    setJsonText('')
    setImportError(null)
  }

  const handleAddServer = async () => {
    if (!newServerUrl || !isUrlValid) {
      return
    }
    await addServerMutation.mutateAsync({ id: uuidv7(), name: resolveServerName(), url: newServerUrl })
    form.resetAddDialog()
    resetLocalDialogState()
  }

  const handleUpdateServer = async () => {
    if (!form.editingServerId || !newServerUrl || !isUrlValid) {
      return
    }
    const id = form.editingServerId
    const name = resolveServerName()
    const transport = newServerTransport
    // Carry the current enabled flag through. The row's enabled bit isn't part
    // of this dialog, so we mirror the in-memory state to avoid an inadvertent
    // toggle. Falls back to enabled=true for a defensively-missing entry.
    const existing = mcpServers.find((s) => s.id === id)
    const enabled = existing?.enabled ?? true
    await updateServerMutation.mutateAsync({
      id,
      name,
      url: newServerUrl,
      transport,
      token: newServerToken,
      originalCredentialType: credentialTypeById[id] ?? 'none',
    })
    // Push the patch into the MCP provider so the live client redials with the
    // new url/type/credentials. useMcpSync would catch row changes eventually
    // via PowerSync, but credential-only edits don't touch the row at all —
    // updateServer's reconnect re-reads `mcp_secrets` so both paths converge.
    // forceRedial: the dialog may have just written new credentials. When the
    // initial connect for this server is still in-flight, that connect read
    // credentials at its start and would otherwise leave the new value
    // stranded; the flag chains a reconnect onto it.
    updateServer({ id, name, url: newServerUrl, type: transport, enabled }, { forceRedial: true })
    form.resetAddDialog()
    resetLocalDialogState()
  }

  const handleEditClick = (server: McpServer) => {
    form.openEditDialog(server, bearerTokenById[server.id] ?? null)
  }

  /**
   * Advanced mode: parse the pasted JSON config and create every server it
   * describes (all-or-nothing). On a parse error nothing is created and the
   * collected messages render in the dialog; on success the dialog closes.
   * No connection probe runs for an imported config.
   */
  const handleImportConfig = async () => {
    const result = parseMcpServersConfig(jsonText)
    if (!result.ok) {
      setImportError(result.errors.join('\n'))
      return
    }
    try {
      await importServersMutation.mutateAsync(result.servers)
      form.resetAddDialog()
      resetLocalDialogState()
    } catch (error) {
      console.error('Failed to import MCP servers:', error)
      setImportError('Could not import servers. Please try again.')
    }
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
    if (!newServerUrl || !isUrlValid) {
      return
    }
    const url = newServerUrl
    const id = uuidv7()
    const ok = await startAddAndAuthorize({
      serverId: id,
      serverUrl: url,
      createRow: () => addServerMutation.mutateAsync({ id, name: resolveServerName(), url }),
    })
    // Close the dialog once the flow started cleanly (web navigates away; mobile
    // opened the system browser; desktop completed inline). On failure it stays
    // open with the dialog error so the user can retry.
    if (ok) {
      form.resetAddDialog()
      resetLocalDialogState()
    }
  }

  const handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') {
      return
    }
    e.preventDefault()
    // Metadata-only edit (rename / no connection change): Save Changes is the
    // button's enabled state regardless of testResult, so Enter must mirror it
    // — otherwise pressing Enter after a rename does nothing while the button
    // would have saved.
    if (form.editingServerId && !form.hasConnectionEdits && newServerUrl && isUrlValid) {
      handleUpdateServer()
      return
    }
    if (testResult.kind === 'idle' && newServerUrl && isUrlValid) {
      testConnection()
    } else if (testResult.kind === 'success') {
      form.editingServerId ? handleUpdateServer() : handleAddServer()
    } else if (testResult.kind === 'needs-oauth' && !form.editingServerId) {
      handleAddAndAuthorize()
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

  const handleRetryConnection = async (serverId: string) => {
    setRetryingServerId(serverId)
    try {
      await reconnectServer(serverId)
    } finally {
      setRetryingServerId(null)
    }
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
            resetLocalDialogState()
          }}
        >
          <DialogTrigger asChild>
            <Button variant="outline" size="icon" className="rounded-lg">
              <Plus />
            </Button>
          </DialogTrigger>
          <ResponsiveModalContentComposable className="sm:max-w-[500px] max-h-[85vh]">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>{form.editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}</ResponsiveModalTitle>
              <ResponsiveModalDescription className="sr-only">
                {form.editingServerId ? 'Edit MCP server' : 'Add a new MCP server'}
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>

            {/* Advanced (JSON) is bulk-import only — irrelevant when editing a single server. */}
            {!form.editingServerId && (
              <ToggleGroup
                type="single"
                variant="outline"
                value={mode}
                onValueChange={(value) => {
                  if (value !== 'simple' && value !== 'advanced') {
                    return
                  }
                  // Each mode owns a different error source (JSON import vs OAuth
                  // authorization). Clear both on switch so a stale message from the
                  // mode you're leaving can't surface under the new mode's UI.
                  setImportError(null)
                  clearDialogError()
                  setMode(value)
                }}
                className="w-full flex-shrink-0"
              >
                <ToggleGroupItem value="simple">Simple</ToggleGroupItem>
                <ToggleGroupItem value="advanced">Advanced (JSON)</ToggleGroupItem>
              </ToggleGroup>
            )}

            <div className="flex-1 overflow-y-auto px-1 -mx-1">
              {mode === 'simple' ? (
                <div className="grid gap-4 pt-4 pb-2">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      placeholder="Server name (used to prefix tools)"
                      value={newServerName}
                      onChange={(e) => form.changeName(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="url">Server URL</Label>
                    <Input
                      id="url"
                      placeholder="http://localhost:8000/mcp/"
                      value={newServerUrl}
                      onChange={(e) => form.changeUrl(e.target.value)}
                      onBlur={handleUrlBlur}
                      onKeyDown={handleUrlKeyDown}
                      aria-invalid={urlValidation?.ok === false}
                    />
                    {urlValidation?.ok === false && (
                      <p className="text-[length:var(--font-size-xs)] text-destructive">{urlValidation.reason}</p>
                    )}
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="transport">Transport</Label>
                    <Select
                      value={newServerTransport}
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
                      value={newServerToken}
                      onChange={(e) => form.changeToken(e.target.value)}
                    />
                  </div>

                  {newServerUrl && isUrlValid && (
                    <Button
                      onClick={testConnection}
                      disabled={isTestingConnection}
                      variant="outline"
                      className="w-full"
                    >
                      {isTestingConnection ? 'Testing Connection...' : 'Test Connection'}
                    </Button>
                  )}

                  {testResult.kind === 'success' && (
                    <StatusPanel tone="success" icon={<Check className="h-4 w-4" />} title="Connection successful!">
                      {serverCapabilities.length > 0 && (
                        <div className="mt-3">
                          <p className="text-sm text-success font-medium">Available tools:</p>
                          <ul className="text-sm text-success/90 mt-1 space-y-1 max-h-40 overflow-y-auto">
                            {serverCapabilities.map((capability, index) => (
                              <li key={index} className="flex items-center gap-2">
                                <div className="w-1 h-1 bg-success rounded-full" />
                                {capability}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </StatusPanel>
                  )}

                  {testResult.kind !== 'success' &&
                    testResult.kind !== 'idle' &&
                    (() => {
                      const panel = testResultPanels[testResult.kind]
                      return (
                        <StatusPanel tone={panel.tone} icon={panel.icon} title={panel.title}>
                          <p className={`text-sm mt-1 ${toneClasses[panel.tone].body}`}>{panel.body}</p>
                        </StatusPanel>
                      )
                    })()}
                </div>
              ) : (
                <div className="grid gap-4 pt-4 pb-2">
                  <div className="grid gap-2">
                    <Label htmlFor="json-config">Servers JSON</Label>
                    <Textarea
                      id="json-config"
                      className="font-mono text-[length:var(--font-size-xs)] min-h-48 max-h-[40vh] overflow-y-auto resize-none"
                      placeholder={
                        '{\n  "mcpServers": {\n    "example": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}'
                      }
                      value={jsonText}
                      onChange={(e) => setJsonText(e.target.value)}
                    />
                    <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                      Paste an <code>mcpServers</code> config. Only remote (http/sse) servers are supported; non-Bearer
                      auth headers are ignored.
                    </p>
                  </div>
                </div>
              )}

              {addDialogError && (
                <div className="mb-2">
                  <StatusPanel tone="destructive" icon={<X className="h-4 w-4" />} title={addDialogError.title}>
                    <p className="text-sm text-destructive/90 mt-1 whitespace-pre-line">{addDialogError.body}</p>
                  </StatusPanel>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2 flex-shrink-0">
              <Button
                variant="ghost"
                onClick={() => {
                  form.resetAddDialog()
                  resetLocalDialogState()
                }}
              >
                Cancel
              </Button>
              {form.editingServerId ? (
                <Button
                  onClick={handleUpdateServer}
                  disabled={
                    !newServerUrl ||
                    !isUrlValid ||
                    // Connection-affecting fields untouched ⇒ existing credential
                    // (including OAuth) is presumed valid; otherwise require a
                    // fresh successful probe.
                    (form.hasConnectionEdits && testResult.kind !== 'success') ||
                    updateServerMutation.isPending
                  }
                >
                  Save Changes
                </Button>
              ) : mode === 'advanced' ? (
                <Button onClick={handleImportConfig} disabled={!jsonText.trim() || importServersMutation.isPending}>
                  Import Servers
                </Button>
              ) : testResult.kind === 'needs-oauth' ? (
                <Button
                  onClick={handleAddAndAuthorize}
                  disabled={!newServerUrl || !isUrlValid || isAddAuthorizePending}
                >
                  <LockKeyhole className="h-3.5 w-3.5 mr-1.5" />
                  Add &amp; Authorize
                </Button>
              ) : (
                <Button
                  onClick={handleAddServer}
                  disabled={!newServerUrl || !isUrlValid || testResult.kind !== 'success'}
                >
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
          const isEnabled = server.enabled === 1
          const oauthState = getOAuthCardState(server)
          const isAuthorizing = oauthState?.phase === 'authorizing'
          const showAuthorize = oauthState?.phase === 'needs-auth' || oauthState?.phase === 'error'
          const isAuthorized = oauthState?.phase === 'authorized'
          const conn = mcpServers.find((s) => s.id === server.id)
          // Tools render only for the LIVE connection — after a drop the card
          // shows its error state, never the previous connection's cached list.
          // (During an in-place reconnect, e.g. re-authorize, isConnected stays
          // true so the list doesn't blink.)
          const tools = conn?.isConnected ? (serverTools[server.id] ?? []) : []
          // A genuine connection failure: enabled, not connected, has an error, and
          // not an OAuth needs-auth case (those get the Authorize affordance instead).
          const connectionError =
            isEnabled && !conn?.isConnected && conn?.error && oauthState === null ? conn.error : null
          const isRetrying = retryingServerId === server.id

          return (
            <Card key={server.id} className="border border-border">
              <CardHeader className="py-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <StatusIndicator
                            status={connectionError ? 'error' : (status as 'connected' | 'connecting' | 'disconnected')}
                            size="md"
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>{connectionError ? 'Connection error' : getStatusTooltipText(status)}</p>
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
                    {connectionError && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isRetrying}
                        onClick={() => handleRetryConnection(server.id)}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`} />
                        {isRetrying ? 'Retrying...' : 'Retry connection'}
                      </Button>
                    )}
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
                            <Check className="h-3.5 w-3.5 mr-1.5 text-success" />
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label="Edit server"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => handleEditClick(server)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>Edit server</p>
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
              {connectionError && (
                <CardContent className="pt-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="text-sm text-destructive cursor-default">
                        Could not connect to this server. Check the URL and that the server is reachable.
                      </p>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p className="max-w-xs break-words">{connectionError.message}</p>
                    </TooltipContent>
                  </Tooltip>
                </CardContent>
              )}
              {oauthState?.phase === 'needs-auth' && (
                <CardContent className="pt-0">
                  <p className="text-sm text-muted-foreground">
                    {oauthState.message ?? 'This server requires authorization. Click Authorize to connect.'}
                  </p>
                </CardContent>
              )}
              {oauthState?.phase === 'error' && (
                <CardContent className="pt-0">
                  <p className="text-sm text-destructive">{oauthState.message}</p>
                </CardContent>
              )}
              {isEnabled && tools.length > 0 && (
                <CardContent className="pt-0 border-t">
                  <AvailableTools
                    className="pt-4"
                    tools={tools.map((tool) => ({
                      name: tool,
                      enabled: true,
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
