/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { useLingui } from '@lingui/react/macro'
import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { DetailPanel } from '@/components/detail-panel'
import { DetailPanelOverlay } from '@/components/detail-panel-overlay'
import { useAppNodeId } from '@/components/settings/iroh-pairing-panel'
import { useDatabase, useHttpClient } from '@/contexts'
import { useAddServerForm } from '@/hooks/use-add-server-form'
import { useMcpServerOAuth } from '@/hooks/use-mcp-server-oauth'
import { probeMcpServerTools } from '@/lib/mcp-connection-test'
import { classifyMcpServerAuth } from '@/lib/mcp-auth/web-oauth-flow'
import { selfEnrollIrohNodeId } from '@/lib/iroh-enrollment'
import { useMCP } from '@/lib/mcp-provider'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { McpServerForm } from '@/settings/connections/mcp-server-form'
import { connectionsPageReducer, createConnectionsPageState } from '@/settings/connections/page-state'
import { useMcpServerFormController } from '@/settings/connections/use-mcp-server-form-controller'

/** Reuse the Connections settings form, probes, credentials and save/authentication flows in a child aside. */
export const CreateConnectionPanel = ({ onClose }: { onClose: () => void }) => {
  const { t } = useLingui()
  const db = useDatabase()
  const httpClient = useHttpClient()
  const cloudUrl = useLocalSettingsStore((state) => state.cloudUrl)
  const buildOAuthFetch = useProxyFetchGetter()
  const { reconnectServer, updateServer } = useMCP()
  const [state, dispatch] = useReducer(connectionsPageReducer, createConnectionsPageState(false))
  const oauth = useMcpServerOAuth({ db, buildOAuthFetch, reconnectServer, clearNavState: () => {} })
  const form = useAddServerForm({
    cloudUrl,
    deps: { buildOAuthFetch, probeMcpServerTools, classifyMcpServerAuth },
    onClearDialogError: oauth.clearDialogError,
  })
  const appNodeId = useAppNodeId(form.isIroh)
  const controller = useMcpServerFormController({
    db,
    form,
    servers: [],
    credentialsById: {},
    jsonText: state.jsonText,
    dispatch: (action) => {
      dispatch(action)
      if (action.type === 'FORM_RESET') {
        onClose()
      }
    },
    clearDialogError: oauth.clearDialogError,
    startAddAndAuthorize: oauth.startAddAndAuthorize,
    updateLiveServer: updateServer,
    enrollIroh: () => selfEnrollIrohNodeId(httpClient, irohClientNodeId),
  })
  const errorSources = [
    { title: t`Import failed`, body: state.importError },
    { title: t`Add failed`, body: state.addError },
    { title: t`Save failed`, body: state.updateError },
    { title: t`Authorization error`, body: oauth.dialogError },
  ]
  const errorPanel =
    errorSources.find((source): source is { title: string; body: string } => source.body !== null) ?? null

  return (
    <DetailPanelOverlay open title={t`Add connection`} onClose={controller.cancel}>
      <DetailPanel title={t`Add connection`} onClose={controller.cancel}>
        <McpServerForm
          form={form}
          mode={state.mode}
          onModeChange={controller.changeMode}
          jsonText={state.jsonText}
          onJsonTextChange={(value) => dispatch({ type: 'JSON_CHANGED', value })}
          errorPanel={errorPanel}
          appNodeId={appNodeId}
          urlValidation={controller.urlValidation}
          isUrlReady={controller.isUrlReady}
          isSaveReady={controller.isSaveReady}
          isEditProbeWaived={controller.isEditProbeWaived}
          isAddAuthorizePending={oauth.isAddAuthorizePending}
          isSavePending={controller.addMutation.isPending}
          isImportPending={controller.importMutation.isPending}
          onCancel={controller.cancel}
          onAddServer={controller.add}
          onUpdateServer={controller.update}
          onImportConfig={controller.importConfig}
          onAddAndAuthorize={controller.addAndAuthorize}
          onUrlKeyDown={controller.onUrlKeyDown}
        />
      </DetailPanel>
    </DetailPanelOverlay>
  )
}
