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
} from '@/dal'
import type { McpServerCredentials } from '@/dal/mcp-secrets'
import { useDatabase } from '@/contexts'
import { mcpSecretsTable, mcpServersTable } from '@/db/tables'
import { useMCP } from '@/lib/mcp-provider'
import { type McpServer } from '@/types'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@powersync/tanstack-react-query'
import { eq } from 'drizzle-orm'
import { Check, Copy, Globe, LockKeyhole, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { probeMcpServerTools } from '@/lib/mcp-connection-test'
import { buildMcpHeaders, createMcpTransport, type MCPTransportType } from '@/lib/mcp-transport'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { getAuthToken } from '@/lib/auth-token'
import { isUnauthorizedError } from '@/lib/mcp-errors'
import { computeEffectiveProxyEnabled, createProxyFetch } from '@/lib/proxy-fetch'
import { setOAuthState } from '@/lib/oauth-state'
import { classifyMcpServerAuth, completeMcpOAuthFlow, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import { clearMcpOAuthState, getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { McpOAuthNeedsReauthError } from '@/lib/mcp-auth/ensure-valid-token'
import {
  decideTestConnectionResult,
  deriveOAuthCardDecision,
  type StoredCredentialType,
  type TestConnectionResult,
} from '@/lib/mcp-auth/auth-decision'
import { parseMcpServersConfig, type ParsedMcpServer } from '@/lib/mcp-config-import'
import { validateMcpServerUrl } from '@/lib/mcp-url-validation'

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

/** Add-dialog mode: a single guided server form, or a raw JSON config paste. */
type AddServerMode = 'simple' | 'advanced'

/**
 * All add-form field state, driven by a reducer so the dialog's many related
 * fields update through one typed channel (per the project's useReducer rule).
 * Imperative bookkeeping (probe ids, debounce guards) lives in refs, not here.
 */
type AddServerFormState = {
  mode: AddServerMode
  name: string
  nameManuallyEdited: boolean
  url: string
  transport: MCPTransportType
  token: string
  jsonText: string
  testResult: TestConnectionResult | { kind: 'idle' }
  /** Dialog-scoped error shown when an action (Authorize / import) fails. */
  addDialogError: string | null
}

type AddServerFormAction =
  | { type: 'setMode'; mode: AddServerMode }
  | { type: 'setName'; name: string }
  | { type: 'setUrl'; url: string }
  | { type: 'setTransport'; transport: MCPTransportType }
  | { type: 'setToken'; token: string }
  | { type: 'setJsonText'; jsonText: string }
  | { type: 'setTestResult'; testResult: TestConnectionResult | { kind: 'idle' } }
  | { type: 'setDialogError'; message: string | null }
  | { type: 'reset' }

/**
 * Editing any probe input (name/url/transport/token) invalidates the stale test
 * result and clears the dialog error, folded into each field's reducer pass.
 */
const invalidatedTest = { testResult: { kind: 'idle' }, addDialogError: null } as const

const initialAddServerFormState: AddServerFormState = {
  mode: 'simple',
  name: '',
  nameManuallyEdited: false,
  url: '',
  transport: 'http',
  token: '',
  jsonText: '',
  testResult: { kind: 'idle' },
  addDialogError: null,
}

const addServerFormReducer = (state: AddServerFormState, action: AddServerFormAction): AddServerFormState => {
  switch (action.type) {
    case 'setMode':
      return { ...state, mode: action.mode, addDialogError: null }
    case 'setName':
      return { ...state, ...invalidatedTest, name: action.name, nameManuallyEdited: true }
    case 'setUrl':
      // Re-derive the name from the URL until the user edits it directly.
      return {
        ...state,
        ...invalidatedTest,
        url: action.url,
        name: state.nameManuallyEdited ? state.name : generateServerName(action.url),
      }
    case 'setTransport':
      return { ...state, ...invalidatedTest, transport: action.transport }
    case 'setToken':
      return { ...state, ...invalidatedTest, token: action.token }
    case 'setJsonText':
      return { ...state, jsonText: action.jsonText, addDialogError: null }
    case 'setTestResult':
      return { ...state, testResult: action.testResult }
    case 'setDialogError':
      return { ...state, addDialogError: action.message }
    case 'reset':
      return initialAddServerFormState
  }
}

/**
 * Bundles the add-form reducer with the editing-side effects every field share:
 * mutating a field after a probe invalidates the stale result. Returns the
 * current state plus narrow setters so the JSX stays declarative.
 */
const useAddServerForm = () => {
  const [state, dispatch] = useReducer(addServerFormReducer, initialAddServerFormState)
  return {
    state,
    setMode: (mode: AddServerMode) => dispatch({ type: 'setMode', mode }),
    setName: (name: string) => dispatch({ type: 'setName', name }),
    setUrl: (url: string) => dispatch({ type: 'setUrl', url }),
    setTransport: (transport: MCPTransportType) => dispatch({ type: 'setTransport', transport }),
    setToken: (token: string) => dispatch({ type: 'setToken', token }),
    setJsonText: (jsonText: string) => dispatch({ type: 'setJsonText', jsonText }),
    setTestResult: (testResult: TestConnectionResult | { kind: 'idle' }) =>
      dispatch({ type: 'setTestResult', testResult }),
    setDialogError: (message: string | null) => dispatch({ type: 'setDialogError', message }),
    reset: () => dispatch({ type: 'reset' }),
  }
}

/**
 * Page-level UI state outside the add-form: which delete popover is open, which
 * URL was just copied, and whether the Add dialog is open.
 */
const useMcpServersState = () => {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  return {
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    copiedUrl,
    setCopiedUrl,
    isAddDialogOpen,
    setIsAddDialogOpen,
  }
}

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
  const form = useAddServerForm()
  const ui = useMcpServersState()
  const [isTestingConnection, startTesting] = useTransition()
  const [retryingServerId, setRetryingServerId] = useState<string | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRefs = useRef<{ [key: string]: HTMLElement | null }>({})
  // Auto-detect: monotonic id to ignore a stale in-flight probe once the URL
  // changes mid-flight, plus the last URL value auto-probed so the blur and the
  // debounce don't double-fire for the same value.
  const probeIdRef = useRef(0)
  const lastAutoTestedUrlRef = useRef<string | null>(null)

  const {
    mode,
    name: newServerName,
    url: newServerUrl,
    transport: newServerTransport,
    token: newServerToken,
  } = form.state
  const { testResult, addDialogError } = form.state
  // `success` carries its tool list, so the capability list renders from the
  // result directly — no separate serverCapabilities state to keep in sync.
  const serverCapabilities = testResult.kind === 'success' ? testResult.tools : []
  // In simple mode the URL gates auto-detect / Add; advanced mode imports raw JSON.
  const urlValidation = newServerUrl ? validateMcpServerUrl(newServerUrl) : null
  const isUrlValid = urlValidation?.ok === true

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

  // Tools for connected servers, keyed by the connected ids so the query re-runs
  // when the live set changes. Each connected client's tools() is fetched in
  // parallel; failures degrade to an empty list rather than rejecting the query.
  const connectedIds = mcpServers
    .filter((s) => s.isConnected && s.client)
    .map((s) => s.id)
    .sort()
  const { data: serverTools = {} } = useQuery<ServerTools>({
    queryKey: ['mcp-server-tools', connectedIds],
    enabled: connectedIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        connectedIds.map(async (id): Promise<[string, string[]]> => {
          const client = mcpServers.find((s) => s.id === id)?.client
          if (!client) {
            return [id, []]
          }
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
    mutationFn: async ({ name, url }: { name: string; url: string }): Promise<string> => {
      const id = uuidv7()
      // OAuth servers have no credential here — they authorize post-create and
      // reconnect separately (see handleAddAndAuthorize).
      await createMcpServerWithCredentials(
        db,
        { id, name, url, type: newServerTransport, enabled: 1 },
        newServerToken ? { type: 'bearer', token: newServerToken } : undefined,
      )
      return id
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
      ui.setDeleteConfirmOpen(null)
    },
  })

  // Closes the Add dialog and clears all add-form state.
  const resetAddDialog = () => {
    ui.setIsAddDialogOpen(false)
    form.reset()
    lastAutoTestedUrlRef.current = null
  }

  const testConnection = () => {
    if (!newServerUrl || !isUrlValid) {
      return
    }
    // Tag this probe so a slower earlier run can't overwrite a newer one's result
    // (the URL can change while a probe is in flight), and record the tested value
    // so the blur + debounce auto-triggers don't double-probe it.
    const probeId = ++probeIdRef.current
    lastAutoTestedUrlRef.current = newServerUrl

    form.setTestResult({ kind: 'idle' })

    startTesting(async () => {
      try {
        // Build the transport the same way the provider does — through the
        // universal proxy so the test matches the real connection path (web CORS
        // would otherwise fail for remote servers).
        const headers = buildMcpHeaders(newServerToken || undefined)
        const transport = createMcpTransport(newServerUrl, newServerTransport, cloudUrl, headers)

        const toolNames = await probeMcpServerTools(transport)
        if (probeIdRef.current !== probeId) {
          return
        }
        form.setTestResult({ kind: 'success', tools: toolNames })
      } catch (error) {
        // A 401 here is the OAuth/credential probe signal, not a failure — keep it at warn.
        console.warn('Connection test error:', error)
        // Auth precedence: a supplied credential that 401s is a rejected token (no
        // Authorize). An empty-credential 401 classifies the server: 'authorizable'
        // (DCR/CIMD → Add & Authorize), 'token-only' (OAuth advertised but no usable
        // registration, e.g. GitHub → ask for a static token), or 'none'.
        const oauthActionability =
          !newServerToken && isUnauthorizedError(error)
            ? await classifyMcpServerAuth(newServerUrl, buildOAuthFetch())
            : 'none'
        if (probeIdRef.current !== probeId) {
          return
        }
        form.setTestResult(decideTestConnectionResult({ hasCredential: !!newServerToken, error, oauthActionability }))
      }
    })
  }

  // Auto-detect the server's auth requirement 700ms after the user stops typing a
  // valid URL — a debounced network probe (timer cleared on each keystroke). The
  // manual "Test Connection" button and the URL field's onBlur run the same probe
  // immediately; `lastAutoTestedUrlRef` keeps blur + debounce from probing a value
  // twice. Editing the credential/transport does NOT auto-probe (it only clears the
  // stale result via the field reducer) — re-test those with the button.
  useEffect(() => {
    if (mode !== 'simple' || !isUrlValid || newServerUrl === lastAutoTestedUrlRef.current) {
      return
    }
    const timer = setTimeout(() => {
      if (newServerUrl !== lastAutoTestedUrlRef.current) {
        testConnection()
      }
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newServerUrl, mode])

  // Name prefixes the server's tools in the prompt. Use the user's name when
  // set, otherwise fall back to the value derived from the URL.
  const resolveServerName = () => newServerName.trim() || generateServerName(newServerUrl)

  const handleAddServer = async () => {
    if (!newServerUrl || !isUrlValid) {
      return
    }
    await addServerMutation.mutateAsync({ name: resolveServerName(), url: newServerUrl })
    resetAddDialog()
  }

  /**
   * Advanced mode: parse the pasted JSON config and create every server it
   * describes (all-or-nothing). On a parse error nothing is created and the
   * collected messages render in the dialog; on success the dialog closes.
   * No connection probe runs for an imported config.
   */
  const handleImportConfig = async () => {
    const result = parseMcpServersConfig(form.state.jsonText)
    if (!result.ok) {
      form.setDialogError(result.errors.join('\n'))
      return
    }
    await importServersMutation.mutateAsync(result.servers)
    resetAddDialog()
  }

  /**
   * Empty-credential + OAuth-actionable path: add the server, then start the web
   * OAuth flow for the freshly-created id. On success the browser redirects to the
   * authorization server (the dialog leaves with the navigation); on failure the
   * dialog stays open showing the error, so the failure is visible where the user
   * acted. The created server row also surfaces an Authorize action on its card.
   */
  const handleAddAndAuthorize = async () => {
    if (!newServerUrl || !isUrlValid) {
      return
    }
    form.setDialogError(null)
    const url = newServerUrl
    const id = await addServerMutation.mutateAsync({ name: resolveServerName(), url })
    try {
      setOAuthState({ returnContext: '/settings/mcp-servers' })
      await startMcpOAuthFlow({ db, serverId: id, serverUrl: url, fetchFn: buildOAuthFetch() })
    } catch (error) {
      console.error('Failed to start MCP OAuth flow:', error)
      form.setDialogError('Could not start authorization. Please try again.')
    }
  }

  // Leaving the URL field probes immediately (unless the debounce already did).
  const handleUrlBlur = () => {
    if (isUrlValid && newServerUrl !== lastAutoTestedUrlRef.current) {
      testConnection()
    }
  }

  const handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!isUrlValid) {
        return
      }
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
      ui.setCopiedUrl(url)
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current)
      }
      copiedTimerRef.current = setTimeout(() => ui.setCopiedUrl(null), 2000)
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
        <Dialog
          open={ui.isAddDialogOpen}
          onOpenChange={(open) => {
            ui.setIsAddDialogOpen(open)
            if (!open) {
              resetAddDialog()
            }
          }}
        >
          <DialogTrigger asChild>
            <Button variant="outline" size="icon" className="rounded-lg">
              <Plus />
            </Button>
          </DialogTrigger>
          <ResponsiveModalContentComposable className="sm:max-w-[500px] max-h-[85vh]">
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Add MCP Server</ResponsiveModalTitle>
              <ResponsiveModalDescription className="sr-only">Add a new MCP server</ResponsiveModalDescription>
            </ResponsiveModalHeader>

            <ToggleGroup
              type="single"
              variant="outline"
              value={mode}
              onValueChange={(value) => {
                if (value === 'simple' || value === 'advanced') {
                  form.setMode(value)
                }
              }}
              className="w-full flex-shrink-0"
            >
              <ToggleGroupItem value="simple">Simple</ToggleGroupItem>
              <ToggleGroupItem value="advanced">Advanced (JSON)</ToggleGroupItem>
            </ToggleGroup>

            <div className="flex-1 overflow-y-auto px-1 -mx-1">
              {mode === 'simple' ? (
                <div className="grid gap-4 pt-4 pb-2">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      placeholder="Server name (used to prefix tools)"
                      value={newServerName}
                      onChange={(e) => form.setName(e.target.value)}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="url">Server URL</Label>
                    <Input
                      id="url"
                      placeholder="http://localhost:8000/mcp/"
                      value={newServerUrl}
                      onChange={(e) => form.setUrl(e.target.value)}
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
                      onValueChange={(value) => form.setTransport(value as MCPTransportType)}
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
                      onChange={(e) => form.setToken(e.target.value)}
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
                      value={form.state.jsonText}
                      onChange={(e) => form.setJsonText(e.target.value)}
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
                  <StatusPanel
                    tone="destructive"
                    icon={<X className="h-4 w-4" />}
                    title={mode === 'advanced' ? 'Import failed' : 'Authorization error'}
                  >
                    <p className="text-sm text-destructive/90 mt-1 whitespace-pre-line">{addDialogError}</p>
                  </StatusPanel>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2 flex-shrink-0">
              <Button variant="ghost" onClick={resetAddDialog}>
                Cancel
              </Button>
              {mode === 'advanced' ? (
                <Button
                  onClick={handleImportConfig}
                  disabled={!form.state.jsonText.trim() || importServersMutation.isPending}
                >
                  Import Servers
                </Button>
              ) : testResult.kind === 'needs-oauth' ? (
                <Button onClick={handleAddAndAuthorize} disabled={!newServerUrl || !isUrlValid}>
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
          const tools = serverTools[server.id] || []
          const isEnabled = server.enabled === 1
          const oauthState = getOAuthCardState(server)
          const isAuthorizing = oauthState?.phase === 'authorizing'
          const showAuthorize = oauthState?.phase === 'needs-auth' || oauthState?.phase === 'error'
          const isAuthorized = oauthState?.phase === 'authorized'
          const conn = mcpServers.find((s) => s.id === server.id)
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
                                disabled={ui.copiedUrl === server.url}
                              >
                                {ui.copiedUrl === server.url ? (
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
                    <Popover
                      open={ui.deleteConfirmOpen === server.id}
                      onOpenChange={(open) => ui.setDeleteConfirmOpen(open ? server.id : null)}
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
                            <Button variant="outline" size="sm" onClick={() => ui.setDeleteConfirmOpen(null)}>
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
              <Button onClick={() => ui.setIsAddDialogOpen(true)} variant="outline">
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
