/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMutation, useQuery as useReactQuery, useQueryClient } from '@tanstack/react-query'
import { eq } from 'drizzle-orm'
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'

import { AppLogo } from '@/components/app-logo'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { GoogleIcon, MicrosoftIcon } from '@/components/provider-icons'
import { useAppNodeId } from '@/components/settings/iroh-pairing-panel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ToolItem } from '@/components/available-tools'
import { useDatabase } from '@/contexts'
import {
  createMcpServersWithCredentials,
  createMcpServerWithCredentials,
  deleteIntegrationCredentials,
  deleteMcpServer,
  getRemoteMcpServers,
  setIntegrationEnabled,
  updateMcpServerWithCredentials,
  updateSettings,
} from '@/dal'
import type { McpServerCredentials } from '@/dal/mcp-secrets'
import { mcpSecretsTable, mcpServersTable } from '@/db/tables'
import { generateServerName, useAddServerForm } from '@/hooks/use-add-server-form'
import { useIntegrationStatus } from '@/hooks/use-integration-status'
import { useIsMobile } from '@/hooks/use-mobile'
import { useMcpServerOAuth, type McpOAuthCallback, type OAuthCardState } from '@/hooks/use-mcp-server-oauth'
import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import { useSettings } from '@/hooks/use-settings'
import { configs as googleToolConfigs } from '@/integrations/google/tools'
import { configs as microsoftToolConfigs } from '@/integrations/microsoft/tools'
import { configs as proToolConfigs } from '@/integrations/thunderbolt-pro/tools'
import { getProStatus } from '@/integrations/thunderbolt-pro/utils'
import type { OAuthProvider } from '@/lib/auth'
import { getAuthToken } from '@/lib/auth-token'
import { deriveOAuthCardDecision, type StoredCredentialType } from '@/lib/mcp-auth/auth-decision'
import { McpOAuthNeedsReauthError } from '@/lib/mcp-auth/ensure-valid-token'
import { isMcpOAuthCallback } from '@/lib/mcp-auth/mcp-oauth-state'
import { getOAuthState } from '@/lib/oauth-state'
import { classifyMcpServerAuth } from '@/lib/mcp-auth/web-oauth-flow'
import type { completeMcpOAuthFlow, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import { parseMcpServersConfig, type ParsedMcpServer } from '@/lib/mcp-config-import'
import { probeMcpServerTools } from '@/lib/mcp-connection-test'
import { useMCP, type MCPClient } from '@/lib/mcp-provider'
import type { MCPTransportType } from '@/lib/mcp-transport'
import { validateMcpServerUrl } from '@/lib/mcp-url-validation'
import { computeEffectiveProxyEnabled, createProxyFetch } from '@/lib/proxy-fetch'
import type { StatusState } from '@/components/status-indicator'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { McpServer } from '@/types'
import { ConnectionsList } from './connections-list'
import { IntegrationDetail } from './integration-detail'
import { McpServerDetail } from './mcp-server-detail'
import { McpServerForm, type AddServerMode } from './mcp-server-form'
import type { Integration } from './types'

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

/**
 * True when an MCP connection error is the "token refresh failed, needs a fresh
 * authorization" signal. `defaultCreateClient` resolves the OAuth token BEFORE
 * constructing the client, so this error surfaces raw (un-wrapped) on the
 * provider's `server.error`.
 */
const isNeedsReauthError = (err: unknown): boolean => err instanceof McpOAuthNeedsReauthError

/**
 * Test-only DI seams. The add-form Test Connection probe and OAuth flow
 * primitives are module imports in production; tests override them to exercise
 * the classification + Add & Authorize wiring without real network calls.
 */
export type ConnectionsPageDeps = {
  probeMcpServerTools?: typeof probeMcpServerTools
  classifyMcpServerAuth?: typeof classifyMcpServerAuth
  startMcpOAuthFlow?: typeof startMcpOAuthFlow
  completeMcpOAuthFlow?: typeof completeMcpOAuthFlow
  /** Test/DI override for reading this app's iroh NodeId (the pairing identity).
   *  Production omits and lazy-loads the wasm client only when an iroh target is
   *  entered, keeping the wasm chunk off the entry bundle. */
  loadAppNodeId?: () => Promise<string>
}

/** The row/panel currently selected in the list (the add/edit form has its own state). */
type Selection = { kind: 'integration' | 'server'; id: string } | null

export default function ConnectionsPage({ deps = {} }: { deps?: ConnectionsPageDeps } = {}) {
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
  const { isMobile } = useIsMobile()
  const queryClient = useQueryClient()

  const [selected, setSelected] = useState<Selection>(null)
  const [mode, setMode] = useState<AddServerMode>('simple')
  const [jsonText, setJsonText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<McpServer | null>(null)
  const [retryingServerId, setRetryingServerId] = useState<string | null>(null)
  const [integrationError, setIntegrationError] = useState<string | null>(null)
  const [isProcessingCallback, setIsProcessingCallback] = useState(() => {
    // Only an integrations callback shows the "connecting" state — an MCP
    // callback is handled by the MCP OAuth hook with its own card states.
    const oauth = (location.state as { oauth?: McpOAuthCallback } | null)?.oauth
    return !!oauth && !isMcpOAuthCallback({ code: oauth.code, state: oauth.state, error: oauth.error })
  })

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

  const { url: newServerUrl, isIroh, token: newServerToken, testResult, resolveServerName } = form
  // In simple mode the URL gates auto-detect / Add; advanced mode imports raw JSON.
  // An iroh NodeId isn't a URL, so skip the http/sse URL validation for it — its
  // readiness is a valid target (already detected) plus a name (no derivable
  // fallback exists for a NodeId, unlike a hostname).
  const urlValidation = !isIroh && newServerUrl ? validateMcpServerUrl(newServerUrl) : null
  const isUrlValid = urlValidation?.ok === true
  const isUrlReady = !!newServerUrl && isUrlValid
  const irohReady = isIroh && resolveServerName().length > 0
  // Unified Add/Save readiness both submit paths gate on: iroh needs a valid
  // target + name (no probe exists for it), http/sse a valid URL.
  const isSaveReady = isIroh ? irohReady : isUrlReady
  // Edit save waives the fresh-probe requirement when there's no probe to run
  // (iroh) or the edit doesn't touch the connection (metadata-only, bearer-clear,
  // or an OAuth edit with an empty token).
  const editProbeWaived = isIroh || !form.hasConnectionEdits || form.isClearingBearerOnly || form.isOAuthEdit
  // Load this app's iroh NodeId only while an iroh target is entered — keeps the
  // wasm chunk lazy and off the entry bundle (and the http/sse flow).
  const appNodeId = useAppNodeId(isIroh, deps.loadAppNodeId)

  // The add/edit form surfaces at most one error: a JSON import failure
  // (advanced), an Edit save failure (Save Changes), or an OAuth authorization
  // failure. The title is derived from the error itself — not the current mode —
  // so a message is always labeled by its own context (switching modes clears
  // the other sources, see `handleModeChange`).
  const formError = importError
    ? { title: 'Import failed', body: importError }
    : updateError
      ? { title: 'Save failed', body: updateError }
      : dialogError
        ? { title: 'Authorization error', body: dialogError }
        : null

  // TODO: Add support for stdio servers
  const { data: servers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getRemoteMcpServers(db)),
  })

  // Reactively track each server's stored credential in one pass. `type` drives
  // the panel's auth precedence (oauth → authorized/needs-auth; bearer-401 →
  // generic error; none-401 → needs-auth). `bearerToken` prefills the Edit
  // form's token field — OAuth credentials are intentionally not surfaced
  // there, since the token UI only accepts bearer values and OAuth is managed
  // via the Authorize buttons. Reads the local-only mcp_secrets table.
  const { data: mcpSecrets = [] } = useQuery({
    queryKey: ['mcp-secrets'],
    query: toCompilableQuery(db.select().from(mcpSecretsTable)),
  })
  const credentialsById = useMemo(
    () =>
      mcpSecrets.reduce<Record<string, { type: StoredCredentialType; bearerToken?: string }>>((acc, row) => {
        if (!row.credentials) {
          return acc
        }
        const cred = JSON.parse(row.credentials) as McpServerCredentials
        acc[row.id] = cred.type === 'bearer' ? { type: 'bearer', bearerToken: cred.token } : { type: cred.type }
        return acc
      }, {}),
    [mcpSecrets],
  )

  // Tools for connected servers. The query keys on each CONNECTION's identity
  // (`id:generation`, where the generation changes whenever the provider swaps in
  // a fresh client instance) — keying on the id set alone would serve the dead
  // client's cached tools after a reconnect that doesn't change the set. Each
  // client's tools() is fetched in parallel; failures degrade to an empty list
  // rather than rejecting the query.
  const connectedServers = mcpServers
    .flatMap((s) => (s.isConnected && s.client ? [{ id: s.id, client: s.client }] : []))
    .sort((a, b) => a.id.localeCompare(b.id))
  const { data: serverTools = {} } = useReactQuery<ServerTools>({
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

  // ---------------------------------------------------------------------------
  // Pre-baked integrations (Thunderbolt, Google, Microsoft)
  // ---------------------------------------------------------------------------

  const integrationSettings = useSettings({
    integrations_pro_is_enabled: false,
  })
  const { data: integrationStatusData, isLoading: isIntegrationStatusLoading } = useIntegrationStatus()
  const { data: proStatus } = useReactQuery({
    queryKey: ['proStatus'],
    queryFn: getProStatus,
  })

  // False until every source feeding the rows' enabled state has resolved.
  // The list keys the integration rows on this so their switches remount into
  // the loaded state instead of animating from the pre-load "off" render.
  const integrationsReady =
    !integrationSettings.integrationsProIsEnabled.isLoading && !isIntegrationStatusLoading && proStatus !== undefined

  const integrations = useMemo((): Integration[] => {
    const proEnabled = integrationSettings.integrationsProIsEnabled.value
    const isProUser = proStatus?.isProUser ?? false

    return [
      {
        id: 'thunderbolt',
        name: 'Thunderbolt',
        provider: 'thunderbolt-pro',
        connectLabel: 'Get Pro',
        icon: <AppLogo size={20} />,
        isEnabled: isProUser && proEnabled,
        isConnected: isProUser,
      },
      {
        id: 'google',
        name: 'Google',
        provider: 'google',
        connectLabel: 'Connect Google',
        icon: <GoogleIcon />,
        isEnabled: integrationStatusData?.googleEnabled ?? false,
        isConnected: integrationStatusData?.googleConnected ?? false,
        userEmail: integrationStatusData?.googleEmail ?? undefined,
      },
      {
        id: 'microsoft',
        name: 'Microsoft',
        provider: 'microsoft',
        connectLabel: 'Connect Microsoft',
        icon: <MicrosoftIcon />,
        isEnabled: integrationStatusData?.microsoftEnabled ?? false,
        isConnected: integrationStatusData?.microsoftConnected ?? false,
        userEmail: integrationStatusData?.microsoftEmail ?? undefined,
      },
    ]
  }, [integrationSettings.integrationsProIsEnabled.value, integrationStatusData, proStatus?.isProUser])

  const integrationTools = (integration: Integration): ToolItem[] => {
    const configs =
      integration.provider === 'thunderbolt-pro'
        ? proToolConfigs
        : integration.provider === 'google'
          ? googleToolConfigs
          : microsoftToolConfigs
    const enabled = integration.isConnected && integration.isEnabled
    return configs.map((config) => ({ name: config.name, description: config.description, enabled }))
  }

  const { processCallback: processIntegrationCallback } = useOAuthConnect({
    onError: (err) => {
      setIntegrationError(err.message)
    },
    returnContext: 'integrations',
  })

  const handleGetPro = () => {
    // For now, just show an alert since this is a placeholder
    alert(
      'Thunderbolt Pro upgrade would be handled here. For testing, toggle the IS_PRO_USER constant in src/integrations/thunderbolt-pro/utils.ts',
    )
  }

  const handleDisconnectIntegration = async (integration: Integration) => {
    try {
      await deleteIntegrationCredentials(db, integration.provider as OAuthProvider)
      await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
    } catch (err) {
      console.error('Failed to disconnect integration', err)
      setIntegrationError(err instanceof Error ? err.message : 'Failed to disconnect integration')
    }
  }

  const handleToggleIntegration = async (integration: Integration, enabled: boolean) => {
    try {
      if (integration.provider === 'thunderbolt-pro') {
        await updateSettings(db, { integrations_pro_is_enabled: enabled.toString() })
      } else {
        await setIntegrationEnabled(db, integration.provider, enabled)
        await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
      }
    } catch (err) {
      console.error('Failed to update integration', err)
    }
  }

  // ---------------------------------------------------------------------------
  // MCP server mutations
  // ---------------------------------------------------------------------------

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
      setPendingDelete(null)
    },
  })

  // Clears form-local state (mode, JSON text, form errors) in sync with the
  // form hook's resetAddDialog so a re-open always starts clean.
  const resetLocalFormState = () => {
    setMode('simple')
    setJsonText('')
    setImportError(null)
    setUpdateError(null)
  }

  const handleCancelForm = () => {
    form.resetAddDialog()
    resetLocalFormState()
  }

  const handleModeChange = (next: AddServerMode) => {
    // Each mode owns a different error source (JSON import vs OAuth
    // authorization vs Save-Changes). Clear all on switch so a stale message
    // from the mode you're leaving can't surface under the new mode's UI.
    setImportError(null)
    setUpdateError(null)
    clearDialogError()
    setMode(next)
  }

  const handleAddServer = async () => {
    // iroh stores the trimmed NodeId/ticket as `url` (type='iroh' rides through
    // `form.transport`); http/sse require a valid URL + a successful probe.
    if (!isSaveReady) {
      return
    }
    const url = isIroh ? newServerUrl.trim() : newServerUrl
    await addServerMutation.mutateAsync({ id: uuidv7(), name: resolveServerName(), url })
    handleCancelForm()
  }

  const handleUpdateServer = async () => {
    if (!form.editingServerId || !isSaveReady) {
      return
    }
    const id = form.editingServerId
    // Read enabled from the DB row (source of truth), not the provider's
    // in-memory state — the provider can be briefly stale right after a toggle,
    // and the form doesn't own the enabled bit. If the row disappeared
    // between form open and save (e.g. deleted from another device), bail.
    const dbRow = servers.find((s) => s.id === id)
    if (!dbRow) {
      return
    }
    const name = resolveServerName()
    const transport = form.transport
    const enabled = dbRow.enabled === 1
    // Persist the trimmed NodeId/ticket for iroh (same as the add path) so pasted
    // whitespace can't survive into the stored target and break the peer dial.
    const url = isIroh ? newServerUrl.trim() : newServerUrl
    setUpdateError(null)
    try {
      await updateServerMutation.mutateAsync({
        id,
        name,
        url,
        transport,
        token: newServerToken,
        originalCredentialType: credentialsById[id]?.type ?? 'none',
      })
    } catch (error) {
      console.error('Failed to update MCP server:', error)
      setUpdateError('Could not save changes. Please try again.')
      return
    }
    // Push the patch into the MCP provider so the live client redials with the
    // new url/type/credentials. useMcpSync would catch row changes eventually
    // via PowerSync, but credential-only edits don't touch the row at all —
    // updateServer's reconnect re-reads `mcp_secrets` so both paths converge.
    // forceRedial only when a connection-affecting field was actually edited:
    // for a pure metadata save (rename), skipping it lets the provider keep the
    // healthy client and just apply the row patch, so an active tool call
    // against this server isn't dropped by an unnecessary reconnect.
    updateServer({ id, name, url, type: transport, enabled }, { forceRedial: form.hasConnectionEdits })
    handleCancelForm()
  }

  const handleEditServer = (server: McpServer) => {
    const cred = credentialsById[server.id]
    // Keep the selection so canceling the edit returns to the detail panel.
    setSelected({ kind: 'server', id: server.id })
    form.openEditDialog(server, cred?.bearerToken ?? null, cred?.type ?? 'none')
  }

  /**
   * Advanced mode: parse the pasted JSON config and create every server it
   * describes (all-or-nothing). On a parse error nothing is created and the
   * collected messages render in the form; on success the panel closes.
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
      handleCancelForm()
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
   * authorization server (the panel leaves with the navigation); on failure the
   * hook rolls the row back and surfaces the error in the form. The created
   * server row also surfaces an Authorize action on its detail panel.
   */
  const handleAddAndAuthorize = async () => {
    if (!isUrlReady) {
      return
    }
    const url = newServerUrl
    const id = uuidv7()
    const ok = await startAddAndAuthorize({
      serverId: id,
      serverUrl: url,
      createRow: () => addServerMutation.mutateAsync({ id, name: resolveServerName(), url }),
    })
    // Close the form once the flow started cleanly (web navigates away; mobile
    // opened the system browser; desktop completed inline). On failure it stays
    // open with the form error so the user can retry.
    if (ok) {
      handleCancelForm()
    }
  }

  const handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') {
      return
    }
    e.preventDefault()
    // iroh has no probe step, so in the add flow Enter commits directly. (Editing
    // an iroh server falls through to the shared edit handling below.)
    if (isIroh && !form.editingServerId) {
      handleAddServer()
      return
    }
    // Edit-mode: Enter mirrors the Save Changes button's enabled state — save
    // whenever the button would (iroh, metadata-only, bearer-clear, or OAuth edit
    // with empty token, all of which waive the probe requirement) so those cases
    // don't fall through to the probe branches below.
    if (form.editingServerId && isSaveReady && editProbeWaived) {
      handleUpdateServer()
      return
    }
    if (testResult.kind === 'idle' && isUrlReady) {
      form.testConnection()
      return
    }
    if (testResult.kind === 'success') {
      if (form.editingServerId) {
        handleUpdateServer()
      } else {
        handleAddServer()
      }
      return
    }
    if (testResult.kind === 'needs-oauth' && !form.editingServerId) {
      handleAddAndAuthorize()
    }
  }

  const getConnectionStatus = (server: McpServer): 'connected' | 'connecting' | 'disconnected' => {
    // Get real connection status from MCP provider
    const mcpServer = mcpServers.find((s) => s.id === server.id)
    if (mcpServer) {
      return mcpServer.isConnected ? 'connected' : 'disconnected'
    }
    return server.enabled ? 'connecting' : 'disconnected'
  }

  const handleRetryConnection = async (serverId: string) => {
    setRetryingServerId(serverId)
    try {
      await reconnectServer(serverId)
    } finally {
      setRetryingServerId(null)
    }
  }

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
      credentialType: credentialsById[server.id]?.type ?? 'none',
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

  /** A genuine connection failure: enabled, not connected, has an error, and
   *  not an OAuth needs-auth case (those get the Authorize affordance instead). */
  const getConnectionError = (server: McpServer): Error | null => {
    const conn = mcpServers.find((s) => s.id === server.id)
    const oauthState = getOAuthCardState(server)
    return server.enabled === 1 && !conn?.isConnected && conn?.error && oauthState === null ? conn.error : null
  }

  const rowStatus = (server: McpServer): StatusState =>
    getConnectionError(server) ? 'error' : getConnectionStatus(server)

  // Completes OAuth when navigated back from `/oauth/callback` with the code,
  // state and iss in `location.state`. Both flows land on this page now: the
  // MCP hook claims callbacks belonging to its pending handshake (nonce match);
  // everything else is an integrations (Google/Microsoft) callback.
  useEffect(() => {
    const oauth = (location.state as { oauth?: McpOAuthCallback } | null)?.oauth
    if (!oauth) {
      return
    }
    if (isMcpOAuthCallback({ code: oauth.code, state: oauth.state, error: oauth.error })) {
      processCallback(oauth)
      return
    }
    const handleCallback = async () => {
      setIsProcessingCallback(true)
      // Open the integration's own aside so the connecting state — and any
      // failure — surfaces next to its Connect button, not in the list area.
      const provider = getOAuthState().provider
      if (provider) {
        setSelected({ kind: 'integration', id: provider })
      }
      try {
        await processIntegrationCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
      } finally {
        setIsProcessingCallback(false)
        navigate('.', { replace: true, state: null })
      }
    }
    handleCallback()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  // ---------------------------------------------------------------------------
  // Panel derivation
  // ---------------------------------------------------------------------------

  // Deriving from the live lists means the panel follows sync: if the active
  // server is deleted on another device, `activeServer` turns undefined and
  // the panel closes on its own.
  const activeIntegration =
    selected?.kind === 'integration' ? integrations.find((i) => i.id === selected.id) : undefined
  const activeServer = selected?.kind === 'server' ? servers.find((s) => s.id === selected.id) : undefined

  const renderPanel = () => {
    if (form.isAddDialogOpen) {
      return (
        <DetailPanel title={form.editingServerId ? 'Edit MCP Server' : 'Add MCP Server'} onClose={handleCancelForm}>
          <McpServerForm
            form={form}
            mode={mode}
            onModeChange={handleModeChange}
            jsonText={jsonText}
            onJsonTextChange={setJsonText}
            errorPanel={formError}
            appNodeId={appNodeId}
            urlValidation={urlValidation}
            isUrlReady={isUrlReady}
            isSaveReady={isSaveReady}
            editProbeWaived={editProbeWaived}
            isAddAuthorizePending={isAddAuthorizePending}
            isSavePending={updateServerMutation.isPending}
            isImportPending={importServersMutation.isPending}
            onCancel={handleCancelForm}
            onAddServer={handleAddServer}
            onUpdateServer={handleUpdateServer}
            onImportConfig={handleImportConfig}
            onAddAndAuthorize={handleAddAndAuthorize}
            onUrlKeyDown={handleUrlKeyDown}
          />
        </DetailPanel>
      )
    }
    if (activeIntegration) {
      return (
        <IntegrationDetail
          integration={activeIntegration}
          tools={integrationTools(activeIntegration)}
          isProcessingCallback={isProcessingCallback}
          error={integrationError}
          onGetPro={handleGetPro}
          onDisconnect={() => handleDisconnectIntegration(activeIntegration)}
          onError={(error) => setIntegrationError(error.message)}
          onClose={() => setSelected(null)}
        />
      )
    }
    if (activeServer) {
      const conn = mcpServers.find((s) => s.id === activeServer.id)
      // Tools render only for the LIVE connection — after a drop the panel
      // shows its error state, never the previous connection's cached list.
      // (During an in-place reconnect, e.g. re-authorize, isConnected stays
      // true so the list doesn't blink.)
      const tools = conn?.isConnected ? (serverTools[activeServer.id] ?? []) : []
      return (
        <McpServerDetail
          server={activeServer}
          status={getConnectionStatus(activeServer)}
          connectionError={getConnectionError(activeServer)}
          oauthState={getOAuthCardState(activeServer)}
          tools={tools}
          isRetrying={retryingServerId === activeServer.id}
          onRetry={() => handleRetryConnection(activeServer.id)}
          onAuthorize={() => startAuthorize(activeServer)}
          onEdit={() => handleEditServer(activeServer)}
          onDelete={() => setPendingDelete(activeServer)}
          onClose={() => setSelected(null)}
        />
      )
    }
    return null
  }

  const panel = renderPanel()
  const panelOpen = panel !== null

  const closePanel = () => {
    setIntegrationError(null)
    if (form.isAddDialogOpen) {
      handleCancelForm()
      return
    }
    setSelected(null)
  }

  const toggleSelection = (next: NonNullable<Selection>) => {
    // An integration error is scoped to the aside it happened in — don't
    // carry it over to whichever panel opens next.
    setIntegrationError(null)
    // Selecting a row supersedes an open add/edit form (same as the agents page).
    if (form.isAddDialogOpen) {
      handleCancelForm()
    }
    setSelected((current) =>
      current?.kind === next.kind && current.id === next.id && !form.isAddDialogOpen ? null : next,
    )
  }

  const openAddForm = () => {
    setSelected(null)
    form.openDialog()
  }

  return (
    <div className="relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ConnectionsList
          integrations={integrations}
          integrationsReady={integrationsReady}
          servers={servers}
          serverStatus={rowStatus}
          activeKey={panelOpen && selected && !form.isAddDialogOpen ? `${selected.kind}:${selected.id}` : null}
          onAdd={openAddForm}
          onSelectIntegration={(id) => toggleSelection({ kind: 'integration', id })}
          onSelectServer={(id) => toggleSelection({ kind: 'server', id })}
          onToggleIntegration={handleToggleIntegration}
          onToggleServer={(id, enabled) => toggleServerMutation.mutate({ id, enabled })}
          onEditServer={(id) => {
            const server = servers.find((s) => s.id === id)
            if (server) {
              handleEditServer(server)
            }
          }}
          onDeleteServer={(id) => {
            const server = servers.find((s) => s.id === id)
            if (server) {
              setPendingDelete(server)
            }
          }}
        />
      </div>
      <DetailPanelSurface open={panelOpen} isMobile={isMobile} onClose={closePanel}>
        {panel}
      </DetailPanelSurface>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Server</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this MCP server? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) {
                  deleteServerMutation.mutate(pendingDelete.id)
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export { generateServerName }
