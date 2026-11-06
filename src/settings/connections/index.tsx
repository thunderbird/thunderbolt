/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useReducer } from 'react'
import { Navigate, useLocation } from 'react-router'

import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
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
import { useMcpServerOAuth, type OAuthCardState } from '@/hooks/use-mcp-server-oauth'
import { getAuthToken } from '@/lib/auth-token'
import { deriveOAuthCardDecision } from '@/lib/mcp-auth/auth-decision'
import { McpOAuthNeedsReauthError } from '@/lib/mcp-auth/ensure-valid-token'
import { getMcpSearchProvider } from '@/providers/mcp-search-auth'
import { getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { getOAuthState } from '@/lib/oauth-state'
import { classifyMcpServerAuth } from '@/lib/mcp-auth/web-oauth-flow'
import type { completeMcpOAuthFlow, startMcpOAuthFlow } from '@/lib/mcp-auth/web-oauth-flow'
import { selfEnrollIrohNodeId } from '@/lib/iroh-enrollment'
import { probeMcpServerTools } from '@/lib/mcp-connection-test'
import { useMCP } from '@/lib/mcp-provider'
import { createProxyFetch } from '@/lib/proxy-fetch'
import type { StatusState } from '@/components/status-indicator'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { McpServer } from '@/types'
import { useAiProviderConnections } from './use-ai-provider-connections'
import { getProviderAuthorizationReturn, useProviderAuthorization } from '@/providers/use-provider-authorization'
import { getProviderDefinition } from '@/providers/registry'
import { ProviderConnectionDetail } from './provider-connection-detail'
import { ProviderConnectionForm } from './provider-connection-form'
import { NewConnectionPicker } from './new-connection-picker'
import { ConnectionsList } from './connections-list'
import { IntegrationDetail } from './integration-detail'
import { McpServerDetail } from './mcp-server-detail'
import { McpServerForm } from './mcp-server-form'
import { getConnectionsOAuthCallback } from './oauth-callback'
import {
  connectionsPageReducer,
  createConnectionsPageState,
  type ConnectionSelection,
  type ConnectionsPageState,
} from './page-state'
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

type ConnectionSurfaceProps = {
  connectionId?: string
  initialAction?: 'edit' | 'remove'
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
}

/** Opens the same connection flow over the current route. */
export const CreateConnectionPanel = (surface: ConnectionSurfaceProps) => <ConnectionsPage surface={surface} />

const ConnectionsPage = ({
  deps = {},
  surface,
}: { deps?: ConnectionsPageDeps; surface?: ConnectionSurfaceProps } = {}) => {
  const { t } = useLingui()
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

  const initialCallback = getConnectionsOAuthCallback(location.state)
  const [state, dispatch] = useReducer(
    connectionsPageReducer,
    initialCallback.kind === 'integration',
    (processing): ConnectionsPageState => {
      const initialState = createConnectionsPageState(processing)
      const providerReturn = getProviderAuthorizationReturn()
      if (providerReturn) {
        return { ...initialState, selected: { kind: 'add-provider', id: providerReturn.attempt.provider } }
      }
      const mcpProvider = getMcpSearchProvider(getMcpOAuthState().serverId)
      if (initialCallback.kind === 'mcp' && mcpProvider) {
        return { ...initialState, selected: { kind: 'add-provider', id: mcpProvider } }
      }
      if (surface?.connectionId) {
        return {
          ...initialState,
          selected: { kind: 'provider', id: surface.connectionId, action: surface.initialAction },
        }
      }
      if (typeof location.state?.providerConnectionId === 'string') {
        return {
          ...initialState,
          selected: { kind: 'provider', id: location.state.providerConnectionId },
        }
      }
      if (surface || location.state?.addConnection === true) {
        return { ...initialState, selected: { kind: 'new', id: '' }, shouldClearNavigationState: !surface }
      }
      return initialState
    },
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

  // OAuth discovery/exchange share the transport's platform/toggle-aware fetch;
  // hosted requests use `/v1/proxy` and its SSRF checks.
  const buildOAuthFetch = () =>
    createProxyFetch({
      cloudUrl,
      getProxyAuthToken: getAuthToken,
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

  // The add/edit form surfaces at most one error: the first non-null source
  // wins. The title is derived from the error itself — not the current mode —
  // so a message is always labeled by its own context (switching modes clears
  // the other sources, see `changeMode`).
  const formErrorSources = [
    { title: t`Import failed`, body: importError },
    { title: t`Add failed`, body: addError },
    { title: t`Save failed`, body: updateError },
    { title: t`Authorization error`, body: dialogError },
  ]
  const formError =
    formErrorSources.find((source): source is { title: string; body: string } => source.body != null) ?? null

  const { servers, areServersReady, credentialsById, serverTools } = useMcpServersData(db, mcpServers)

  const providerConnections = useAiProviderConnections()
  const aiProviders = providerConnections.providers
  const providerSaved = (id: string) => dispatch({ type: 'PROVIDER_SAVED', id })
  const authorization = useProviderAuthorization({ onConnected: providerSaved })

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

  /** The live provider connection for a stored server row, when one exists. */
  const connectionFor = (serverId: string) => mcpServers.find((s) => s.id === serverId)

  const getConnectionStatus = (server: McpServer): 'connected' | 'connecting' | 'disconnected' => {
    const mcpServer = connectionFor(server.id)
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
        error: error instanceof Error ? error.message : t`Failed to reconnect MCP server`,
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
    const conn = connectionFor(server.id)
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
    const conn = connectionFor(server.id)
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
    processMcpCallback: async (callback) => {
      if (getMcpSearchProvider(getMcpOAuthState().serverId)) {
        await authorization.processMcpCallback(callback)
        dispatch({ type: 'NAVIGATION_STATE_CONSUMED' })
        return
      }
      return processCallback(callback)
    },
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
        <DetailPanel title={form.editingServerId ? t`Edit MCP Server` : t`Add MCP Server`} onClose={closePanel}>
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
            isEditProbeWaived={formController.isEditProbeWaived}
            isAddAuthorizePending={isAddAuthorizePending}
            isSavePending={formController.updateMutation.isPending || formController.addMutation.isPending}
            isImportPending={formController.importMutation.isPending}
            onCancel={closePanel}
            onBack={!form.editingServerId ? backToPicker : undefined}
            onAddServer={formController.add}
            onUpdateServer={formController.update}
            onImportConfig={formController.importConfig}
            onAddAndAuthorize={formController.addAndAuthorize}
            onUrlKeyDown={formController.onUrlKeyDown}
          />
        </DetailPanel>
      )
    }
    if (selected?.kind === 'new') {
      return (
        <DetailPanel title={t`New Connection`} onClose={closePanel}>
          <NewConnectionPicker
            onProvider={(id) => {
              const existing = aiProviders.find(
                (connection) => connection.provider === id && connection.authMethod === 'oauth',
              )
              dispatch({
                type: 'SELECTION_CHANGED',
                selection: existing
                  ? { kind: 'provider', id: existing.id, fromPicker: true }
                  : { kind: 'add-provider', id },
              })
            }}
            onMcp={openAddForm}
            integrations={integrationsController.integrations}
            onIntegration={(id) =>
              dispatch({ type: 'SELECTION_CHANGED', selection: { kind: 'integration', id, fromPicker: true } })
            }
          />
        </DetailPanel>
      )
    }
    const connection =
      selected?.kind === 'provider' ? aiProviders.find((provider) => provider.id === selected.id) : undefined
    if (connection) {
      return (
        <ProviderConnectionDetail
          key={`${connection.id}:${selected?.kind === 'provider' ? selected.action : ''}:${state.providerSaveVersion}`}
          initialAction={selected?.kind === 'provider' ? selected.action : undefined}
          onBack={selected?.kind === 'provider' && selected.fromPicker ? backToPicker : undefined}
          connection={connection}
          controls={providerConnections}
          authorization={authorization}
          onAddApiKey={() => selectConnection({ kind: 'add-provider', id: connection.provider, authMethod: 'api_key' })}
          onClose={closePanel}
        />
      )
    }
    if (selected?.kind === 'add-provider') {
      return (
        <DetailPanel title={getProviderDefinition(selected.id).name} onClose={closePanel}>
          <ProviderConnectionForm
            key={`${selected.id}:${selected.authMethod ?? 'oauth'}`}
            initialAuthMethod={selected.authMethod}
            provider={selected.id}
            existingOAuth={aiProviders.find(
              (connection) => connection.provider === selected.id && connection.authMethod === 'oauth',
            )}
            authorization={authorization}
            onSaved={providerSaved}
            onCancel={closePanel}
            onBack={backToPicker}
          />
        </DetailPanel>
      )
    }
    if (activeIntegration) {
      return (
        <IntegrationDetail
          key={`${activeIntegration.id}:${selected?.kind === 'integration' ? selected.action : ''}`}
          initialAction={selected?.kind === 'integration' ? selected.action : undefined}
          integration={activeIntegration}
          onBack={selected?.kind === 'integration' && selected.fromPicker ? backToPicker : undefined}
          tools={integrationsController.toolsFor(activeIntegration)}
          isProcessingCallback={isProcessingCallback}
          error={integrationError}
          onGetPro={integrationsController.getPro}
          onDisconnect={() => integrationsController.disconnect(activeIntegration)}
          onError={(error) => dispatch({ type: 'INTEGRATION_FAILED', error: error.message })}
          onClose={closePanel}
        />
      )
    }
    if (activeServer) {
      const conn = connectionFor(activeServer.id)
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
          onClose={closePanel}
        />
      )
    }
    return null
  }

  const closePanel = () => {
    authorization.cancel()
    dispatch({ type: 'INTEGRATION_ERROR_CLEARED' })
    if (surface) {
      surface.onClose()
      return
    }
    if (form.isAddFormOpen) {
      formController.cancel()
      return
    }
    dispatch({ type: 'SELECTION_CHANGED', selection: null })
  }

  const backToPicker = () => {
    authorization.cancel()
    if (form.isAddFormOpen) {
      formController.cancel()
    }
    dispatch({ type: 'SELECTION_CHANGED', selection: { kind: 'new', id: '' } })
  }

  const selectConnection = (next: NonNullable<ConnectionSelection>, toggle = false) => {
    authorization.cancel()
    const isReselected = toggle && !form.isAddFormOpen && selected?.kind === next.kind && selected.id === next.id
    // Row clicks and context-menu actions both supersede the current form and authorization.
    if (form.isAddFormOpen) {
      formController.cancel()
    }
    dispatch({ type: 'SELECTION_CHANGED', selection: isReselected ? null : next })
  }

  const openAddForm = () => {
    authorization.cancel()
    dispatch({ type: 'SELECTION_CHANGED', selection: null })
    form.openAddForm()
  }

  /** Run an action against a stored server row, ignoring ids that no longer resolve (deleted mid-render). */
  const withServer = (id: string, action: (server: McpServer) => void) => {
    const server = servers.find((s) => s.id === id)
    if (server) {
      authorization.cancel()
      action(server)
    }
  }

  const panel = renderPanel()
  const panelOpen = panel !== null

  return (
    <div className={surface ? 'contents' : 'relative flex h-full'}>
      {!surface && (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ConnectionsList
            aiProviders={aiProviders}
            areProvidersReady={providerConnections.ready}
            isProviderTogglePending={providerConnections.pending}
            providerError={providerConnections.error ?? authorization.error}
            onToggleProvider={providerConnections.toggle}
            onEditProvider={(id) => selectConnection({ kind: 'provider', id, action: 'edit' })}
            onRemoveProvider={(id) => selectConnection({ kind: 'provider', id, action: 'remove' })}
            onRemoveIntegration={(id) => selectConnection({ kind: 'integration', id, action: 'remove' })}
            onSelectProvider={(id) => selectConnection({ kind: 'provider', id }, true)}
            integrations={integrationsController.integrations.filter((integration) => integration.isConnected)}
            areIntegrationsReady={integrationsController.areIntegrationsReady}
            servers={servers}
            areServersReady={areServersReady}
            serverStatus={rowStatus}
            activeKey={panelOpen && selected && !form.isAddFormOpen ? `${selected.kind}:${selected.id}` : null}
            onAdd={() => {
              authorization.cancel()
              formController.cancel()
              dispatch({ type: 'SELECTION_CHANGED', selection: { kind: 'new', id: '' } })
            }}
            onSelectIntegration={(id) => selectConnection({ kind: 'integration', id }, true)}
            onSelectServer={(id) => selectConnection({ kind: 'server', id }, true)}
            onToggleIntegration={integrationsController.toggle}
            onToggleServer={(id, enabled) => formController.toggleMutation.mutate({ id, enabled })}
            onEditServer={(id) => withServer(id, formController.edit)}
            onDeleteServer={(id) => withServer(id, (server) => dispatch({ type: 'DELETE_REQUESTED', server }))}
          />
        </div>
      )}
      <DetailPanelSurface
        open={surface ? surface.open : panelOpen}
        onClose={closePanel}
        onCloseComplete={surface?.onCloseComplete}
        topInset={Boolean(surface)}
      >
        {panel}
      </DetailPanelSurface>
      {providerConnections.pendingDisable && (
        <ConfirmActionDialog
          open
          title={t`Disable ${providerConnections.pendingDisable.name}?`}
          description={t`Models and search using this connection will be unavailable until you enable it again.`}
          confirmLabel={t`Disable connection`}
          onConfirm={providerConnections.confirmDisable}
          onCancel={providerConnections.cancelDisable}
        />
      )}
      {shouldClearNavigationState && location.state !== null && (!surface || location.state.oauth) && (
        <Navigate
          to={`${location.pathname}${location.search}${location.hash}`}
          replace
          state={surface ? { connectionOAuthReturn: location.state.connectionOAuthReturn } : null}
        />
      )}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && dispatch({ type: 'DELETE_DISMISSED' })}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Delete Server</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Delete this MCP server and its saved credentials?</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={formController.deleteMutation.isPending}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={formController.deleteMutation.isPending}
              // Fire-and-forget: the mutation's onError/onSuccess own the outcome.
              onClick={() => pendingDelete && formController.deleteMutation.mutate(pendingDelete.id)}
            >
              {formController.deleteMutation.isPending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ConnectionsPage
