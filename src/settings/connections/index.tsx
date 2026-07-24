/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { Navigate, useLocation } from 'react-router'

import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
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
import { useDatabase, useHttpClient } from '@/contexts'
import { useAddServerForm } from '@/hooks/use-add-server-form'
import { useIsMobile } from '@/hooks/use-mobile'
import { useMcpServerOAuth, type OAuthCardState } from '@/hooks/use-mcp-server-oauth'
import { getAuthToken } from '@/lib/auth-token'
import { deriveOAuthCardDecision } from '@/lib/mcp-auth/auth-decision'
import { McpOAuthNeedsReauthError } from '@/lib/mcp-auth/ensure-valid-token'
import { getOAuthState } from '@/lib/oauth-state'
import { classifyMcpServerAuth } from '@/lib/mcp-auth/web-oauth-flow'
import type { completeMcpOAuthFlow, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import { selfEnrollIrohNodeId } from '@/lib/iroh-enrollment'
import { probeMcpServerTools } from '@/lib/mcp-connection-test'
import { useMCP } from '@/lib/mcp-provider'
import { computeEffectiveProxyEnabled, createProxyFetch } from '@/lib/proxy-fetch'
import type { StatusState } from '@/components/status-indicator'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { McpServer } from '@/types'
import { ConnectionsList } from './connections-list'
import { IntegrationDetail } from './integration-detail'
import { McpServerDetail } from './mcp-server-detail'
import { McpServerForm } from './mcp-server-form'
import { getConnectionsOAuthCallback } from './oauth-callback'
import { connectionsPageReducer, createConnectionsPageState, type ConnectionSelection } from './page-state'
import { useConnectionsOAuthCallback } from './use-connections-oauth-callback'
import { useIntegrationsController } from './use-integrations-controller'
import { useMcpServersData } from './use-mcp-servers-data'
import { useMcpServerFormController } from './use-mcp-server-form-controller'

/**
 * True when an MCP connection error is the "token refresh failed, needs a fresh
 * authorization" signal. `defaultCreateClient` resolves the OAuth token BEFORE
 * constructing the client, so this error surfaces raw (un-wrapped) on the
 * provider's `server.error`.
 */
const isNeedsReauthError = (err: unknown): boolean => err instanceof McpOAuthNeedsReauthError

/** Reads the integration provider associated with the pending OAuth handshake. */
const getPendingIntegrationProvider = () => getOAuthState().provider

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
  /** Test/DI override for app NodeId self-enrollment, fired when an iroh bridge is added.
   *  Production omits and binds the authenticated client. */
  enrollIroh?: () => Promise<void>
}

const ConnectionsPage = ({ deps = {} }: { deps?: ConnectionsPageDeps } = {}) => {
  const probeTools = deps.probeMcpServerTools ?? probeMcpServerTools
  const classifyAuth = deps.classifyMcpServerAuth ?? classifyMcpServerAuth
  const db = useDatabase()
  const httpClient = useHttpClient()
  const runEnroll = deps.enrollIroh ?? (() => selfEnrollIrohNodeId(httpClient, deps.loadAppNodeId ?? irohClientNodeId))
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  // Read provider connection state read-only for status display. Sync ownership
  // lives in the single global useMcpSync() in AppContent — running it here too
  // would re-run the reconciliation effect and double-register servers.
  const { servers: mcpServers, reconnectServer, updateServer } = useMCP()
  const location = useLocation()
  const { isMobile } = useIsMobile()

  const initialCallback = getConnectionsOAuthCallback(location.state)
  const [state, dispatch] = useReducer(
    connectionsPageReducer,
    createConnectionsPageState(initialCallback.kind === 'integration'),
  )
  const {
    selected,
    mode,
    jsonText,
    importError,
    addError,
    updateError,
    pendingDelete,
    retryingServerId,
    integrationError,
    serverError,
    isProcessingCallback,
    shouldClearNavigationState,
  } = state

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
    clearNavState: () => dispatch({ type: 'NAVIGATION_STATE_CONSUMED' }),
    startMcpOAuthFlow: deps.startMcpOAuthFlow,
    completeMcpOAuthFlow: deps.completeMcpOAuthFlow,
  })

  const form = useAddServerForm({
    cloudUrl,
    deps: { probeMcpServerTools: probeTools, classifyMcpServerAuth: classifyAuth, buildOAuthFetch },
    onClearDialogError: clearDialogError,
  })

  const { isIroh } = form
  // Load this app's iroh NodeId only while an iroh target is entered — keeps the
  // wasm chunk lazy and off the entry bundle (and the http/sse flow).
  const appNodeId = useAppNodeId(isIroh, deps.loadAppNodeId)

  // The add/edit form surfaces at most one error: a JSON import failure
  // (advanced), an Add failure, an Edit save failure (Save Changes), or an
  // OAuth authorization failure. The title is derived from the error itself —
  // not the current mode — so a message is always labeled by its own context
  // (switching modes clears the other sources, see `changeMode`).
  const formError = importError
    ? { title: 'Import failed', body: importError }
    : addError
      ? { title: 'Add failed', body: addError }
      : updateError
        ? { title: 'Save failed', body: updateError }
        : dialogError
          ? { title: 'Authorization error', body: dialogError }
          : null

  const { servers, credentialsById, serverTools } = useMcpServersData(db, mcpServers)

  const integrationsController = useIntegrationsController({ db, dispatch })

  const formController = useMcpServerFormController({
    db,
    form,
    servers,
    credentialsById,
    jsonText,
    dispatch,
    clearDialogError,
    startAddAndAuthorize,
    updateLiveServer: updateServer,
    enrollIroh: runEnroll,
  })

  const getConnectionStatus = (server: McpServer): 'connected' | 'connecting' | 'disconnected' => {
    // Get real connection status from MCP provider
    const mcpServer = mcpServers.find((s) => s.id === server.id)
    if (mcpServer) {
      return mcpServer.isConnected ? 'connected' : 'disconnected'
    }
    return server.enabled ? 'connecting' : 'disconnected'
  }

  const handleRetryConnection = async (serverId: string) => {
    dispatch({ type: 'RETRY_STARTED', serverId })
    try {
      await reconnectServer(serverId)
    } catch (error) {
      console.error('Failed to reconnect MCP server:', error)
      // Scoped to the server so the failure surfaces in the detail panel where
      // the Retry button lives (on mobile the panel covers the list entirely).
      dispatch({
        type: 'SERVER_FAILED',
        serverId,
        error: error instanceof Error ? error.message : 'Failed to reconnect MCP server',
      })
    } finally {
      dispatch({ type: 'RETRY_SETTLED' })
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
  useConnectionsOAuthCallback({
    locationState: location.state,
    processMcpCallback: processCallback,
    processIntegrationCallback: integrationsController.processCallback,
    getIntegrationProvider: getPendingIntegrationProvider,
    dispatch,
  })

  // ---------------------------------------------------------------------------
  // Panel derivation
  // ---------------------------------------------------------------------------

  // Deriving from the live lists means the panel follows sync: if the active
  // server is deleted on another device, `activeServer` turns undefined and
  // the panel closes on its own.
  const activeIntegration =
    selected?.kind === 'integration' ? integrationsController.integrations.find((i) => i.id === selected.id) : undefined
  const activeServer = selected?.kind === 'server' ? servers.find((s) => s.id === selected.id) : undefined

  const renderPanel = () => {
    if (form.isAddFormOpen) {
      return (
        <DetailPanel
          title={form.editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}
          onClose={formController.cancel}
        >
          <McpServerForm
            form={form}
            mode={mode}
            onModeChange={formController.changeMode}
            jsonText={jsonText}
            onJsonTextChange={(value) => dispatch({ type: 'JSON_CHANGED', value })}
            errorPanel={formError}
            appNodeId={appNodeId}
            urlValidation={formController.urlValidation}
            isUrlReady={formController.isUrlReady}
            isSaveReady={formController.isSaveReady}
            editProbeWaived={formController.editProbeWaived}
            isAddAuthorizePending={isAddAuthorizePending}
            isSavePending={formController.updateMutation.isPending || formController.addMutation.isPending}
            isImportPending={formController.importMutation.isPending}
            onCancel={formController.cancel}
            onAddServer={formController.add}
            onUpdateServer={formController.update}
            onImportConfig={formController.importConfig}
            onAddAndAuthorize={formController.addAndAuthorize}
            onUrlKeyDown={formController.onUrlKeyDown}
          />
        </DetailPanel>
      )
    }
    if (activeIntegration) {
      return (
        <IntegrationDetail
          integration={activeIntegration}
          tools={integrationsController.toolsFor(activeIntegration)}
          isProcessingCallback={isProcessingCallback}
          error={integrationError}
          onGetPro={integrationsController.getPro}
          onDisconnect={() => integrationsController.disconnect(activeIntegration)}
          onError={(error) => dispatch({ type: 'INTEGRATION_FAILED', error: error.message })}
          onClose={() => dispatch({ type: 'SELECTION_CHANGED', selection: null })}
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
          actionError={serverError?.serverId === activeServer.id ? serverError.message : null}
          oauthState={getOAuthCardState(activeServer)}
          tools={tools}
          isRetrying={retryingServerId === activeServer.id}
          onRetry={() => handleRetryConnection(activeServer.id)}
          onAuthorize={() => startAuthorize(activeServer)}
          onEdit={() => formController.edit(activeServer)}
          onDelete={() => dispatch({ type: 'DELETE_REQUESTED', server: activeServer })}
          onClose={() => dispatch({ type: 'SELECTION_CHANGED', selection: null })}
        />
      )
    }
    return null
  }

  const panel = renderPanel()
  const panelOpen = panel !== null

  const closePanel = () => {
    dispatch({ type: 'INTEGRATION_ERROR_CLEARED' })
    if (form.isAddFormOpen) {
      formController.cancel()
      return
    }
    dispatch({ type: 'SELECTION_CHANGED', selection: null })
  }

  const toggleSelection = (next: NonNullable<ConnectionSelection>) => {
    // An integration error is scoped to the aside it happened in — don't
    // carry it over to whichever panel opens next.
    // Selecting a row supersedes an open add/edit form (same as the agents page).
    if (form.isAddFormOpen) {
      formController.cancel()
    }
    const selection = selected?.kind === next.kind && selected.id === next.id && !form.isAddFormOpen ? null : next
    dispatch({ type: 'SELECTION_CHANGED', selection })
  }

  const openAddForm = () => {
    dispatch({ type: 'SELECTION_CHANGED', selection: null })
    form.openAddForm()
  }

  return (
    <div className="relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ConnectionsList
          integrations={integrationsController.integrations}
          integrationsReady={integrationsController.integrationsReady}
          servers={servers}
          serverStatus={rowStatus}
          activeKey={panelOpen && selected && !form.isAddFormOpen ? `${selected.kind}:${selected.id}` : null}
          onAdd={openAddForm}
          onSelectIntegration={(id) => toggleSelection({ kind: 'integration', id })}
          onSelectServer={(id) => toggleSelection({ kind: 'server', id })}
          onToggleIntegration={integrationsController.toggle}
          onToggleServer={(id, enabled) => formController.toggleMutation.mutate({ id, enabled })}
          onEditServer={(id) => {
            const server = servers.find((s) => s.id === id)
            if (server) {
              formController.edit(server)
            }
          }}
          onDeleteServer={(id) => {
            const server = servers.find((s) => s.id === id)
            if (server) {
              dispatch({ type: 'DELETE_REQUESTED', server })
            }
          }}
          error={integrationError}
        />
      </div>
      <DetailPanelSurface open={panelOpen} isMobile={isMobile} onClose={closePanel}>
        {panel}
      </DetailPanelSurface>
      {shouldClearNavigationState && location.state !== null && <Navigate to="." replace state={null} />}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && dispatch({ type: 'DELETE_DISMISSED' })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Server</AlertDialogTitle>
            <AlertDialogDescription>Delete this MCP server and its saved credentials?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={formController.deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={formController.deleteMutation.isPending}
              // Fire-and-forget: the mutation's onError/onSuccess own the outcome.
              onClick={() => pendingDelete && formController.deleteMutation.mutate(pendingDelete.id)}
            >
              {formController.deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ConnectionsPage
