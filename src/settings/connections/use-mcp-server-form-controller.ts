/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, type Dispatch, type KeyboardEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'

import {
  createMcpServersWithCredentials,
  createMcpServerWithCredentials,
  deleteMcpServer,
  updateMcpServerEnabled,
  updateMcpServerWithCredentials,
} from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { useAddServerForm } from '@/hooks/use-add-server-form'
import type { useMcpServerOAuth } from '@/hooks/use-mcp-server-oauth'
import type { StoredCredentialType } from '@/lib/mcp-auth/auth-decision'
import { parseMcpServersConfig, type ParsedMcpServer } from '@/lib/mcp-config-import'
import type { useMCP } from '@/lib/mcp-provider'
import type { MCPTransportType } from '@/lib/mcp-transport'
import { validateMcpServerUrl } from '@/lib/mcp-url-validation'
import type { McpServer } from '@/types'
import type { AddServerMode } from './mcp-server-form'
import type { ConnectionsPageAction } from './page-state'

type FormControllerOptions = {
  db: AnyDrizzleDatabase
  form: ReturnType<typeof useAddServerForm>
  servers: McpServer[]
  credentialsById: Record<string, { type: StoredCredentialType; bearerToken?: string }>
  jsonText: string
  dispatch: Dispatch<ConnectionsPageAction>
  clearDialogError: () => void
  startAddAndAuthorize: ReturnType<typeof useMcpServerOAuth>['startAddAndAuthorize']
  updateLiveServer: ReturnType<typeof useMCP>['updateServer']
  enrollIroh: () => Promise<void>
}

/** Owns MCP add, edit, import, toggle, and delete form operations. */
export const useMcpServerFormController = ({
  db,
  form,
  servers,
  credentialsById,
  jsonText,
  dispatch,
  clearDialogError,
  startAddAndAuthorize,
  updateLiveServer,
  enrollIroh,
}: FormControllerOptions) => {
  const addPendingRef = useRef(false)
  const { url, isIroh, token, testResult, resolveServerName } = form
  const urlValidation = !isIroh && url ? validateMcpServerUrl(url) : null
  const isUrlReady = Boolean(url) && urlValidation?.ok === true
  const isSaveReady = isIroh ? resolveServerName().length > 0 : isUrlReady
  const editProbeWaived = isIroh || !form.hasConnectionEdits || form.isClearingBearerOnly || form.isOAuthEdit

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateMcpServerEnabled(db, id, enabled),
    onError: (error) =>
      dispatch({
        type: 'INTEGRATION_FAILED',
        error: error instanceof Error ? error.message : 'Failed to update MCP server',
      }),
  })
  const addMutation = useMutation({
    mutationFn: ({ id, name, serverUrl }: { id: string; name: string; serverUrl: string }) =>
      createMcpServerWithCredentials(
        db,
        { id, name, url: serverUrl, type: form.transport, enabled: 1 },
        form.token ? { type: 'bearer', token: form.token } : undefined,
      ),
  })
  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      serverUrl,
      transport,
      nextToken,
      isClearingStoredToken,
      originalCredentialType,
    }: {
      id: string
      name: string
      serverUrl: string
      transport: MCPTransportType
      nextToken: string
      isClearingStoredToken: boolean
      originalCredentialType: StoredCredentialType
    }) => {
      // Credential tri-state: a typed token replaces, an explicit clear of a
      // stored bearer deletes (null), and an untouched empty field keeps
      // whatever is stored (undefined).
      const credentials = nextToken
        ? ({ type: 'bearer', token: nextToken } as const)
        : isClearingStoredToken && originalCredentialType === 'bearer'
          ? null
          : undefined
      await updateMcpServerWithCredentials(db, id, { name, url: serverUrl, type: transport }, credentials)
    },
  })
  const importMutation = useMutation({
    mutationFn: (parsed: ParsedMcpServer[]) =>
      createMcpServersWithCredentials(
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
      ),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMcpServer(db, id),
    onSuccess: () => dispatch({ type: 'DELETE_DISMISSED' }),
    onError: (error) =>
      dispatch({
        type: 'INTEGRATION_FAILED',
        error: error instanceof Error ? error.message : 'Failed to remove MCP server',
      }),
  })

  const cancel = () => {
    form.resetAddDialog()
    dispatch({ type: 'FORM_RESET' })
  }
  const changeMode = (mode: AddServerMode) => {
    clearDialogError()
    dispatch({ type: 'MODE_CHANGED', mode })
  }
  const add = async () => {
    if (!isSaveReady || addPendingRef.current) {
      return
    }
    addPendingRef.current = true
    try {
      const serverUrl = isIroh ? url.trim() : url
      await addMutation.mutateAsync({ id: uuidv7(), name: resolveServerName(), serverUrl })
      if (isIroh) {
        // App enrolls its own dialer NodeId; bridge registers itself server-side.
        // Fire and forget: enrollment must never block the add, and manual pairing remains the
        // fallback for Standalone, unauthenticated, or offline use.
        void enrollIroh().catch((error) => {
          console.warn('iroh transparent enrollment failed; using manual pairing fallback', error)
        })
      }
      cancel()
    } catch (error) {
      console.error('Failed to add MCP server:', error)
      dispatch({ type: 'SAVE_FAILED', error: 'Could not add the server. Please try again.' })
    } finally {
      addPendingRef.current = false
    }
  }
  const update = async () => {
    if (!form.editingServerId || !isSaveReady) {
      return
    }
    const id = form.editingServerId
    const row = servers.find((server) => server.id === id)
    if (!row) {
      // The edit form can only open from an existing row; a miss means state corruption.
      throw new Error(`MCP server ${id} is being edited but no longer exists`)
    }
    const name = resolveServerName()
    const transport = form.transport
    const enabled = row.enabled === 1
    const serverUrl = isIroh ? url.trim() : url
    dispatch({ type: 'SAVE_STARTED' })
    try {
      await updateMutation.mutateAsync({
        id,
        name,
        serverUrl,
        transport,
        nextToken: token,
        isClearingStoredToken: form.isClearingStoredToken,
        originalCredentialType: credentialsById[id]?.type ?? 'none',
      })
    } catch (error) {
      console.error('Failed to update MCP server:', error)
      dispatch({ type: 'SAVE_FAILED', error: 'Could not save changes. Please try again.' })
      return
    }
    try {
      await updateLiveServer(
        { id, name, url: serverUrl, type: transport, enabled },
        { forceRedial: form.hasConnectionEdits },
      )
    } catch (error) {
      console.error('Failed to update live MCP server:', error)
      dispatch({ type: 'SAVE_FAILED', error: 'Changes were saved, but reconnecting failed. Please retry.' })
      return
    }
    cancel()
  }
  const edit = (server: McpServer) => {
    const credential = credentialsById[server.id]
    dispatch({ type: 'SELECTION_CHANGED', selection: { kind: 'server', id: server.id } })
    form.openEditDialog(server, credential?.bearerToken ?? null, credential?.type ?? 'none')
  }
  const importConfig = async () => {
    const result = parseMcpServersConfig(jsonText)
    if (!result.ok) {
      dispatch({ type: 'IMPORT_FAILED', error: result.errors.join('\n') })
      return
    }
    try {
      await importMutation.mutateAsync(result.servers)
      cancel()
    } catch (error) {
      console.error('Failed to import MCP servers:', error)
      dispatch({ type: 'IMPORT_FAILED', error: 'Could not import servers. Please try again.' })
    }
  }
  const addAndAuthorize = async () => {
    if (!isUrlReady) {
      return
    }
    const id = uuidv7()
    const started = await startAddAndAuthorize({
      serverId: id,
      serverUrl: url,
      createRow: () => addMutation.mutateAsync({ id, name: resolveServerName(), serverUrl: url }),
    })
    if (started) {
      cancel()
    }
  }
  const onUrlKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') {
      return
    }
    event.preventDefault()
    if (isIroh && !form.editingServerId) {
      void add()
      return
    }
    if (form.editingServerId && isSaveReady && editProbeWaived) {
      void update()
      return
    }
    if (testResult.kind === 'idle' && isUrlReady) {
      void form.testConnection()
      return
    }
    if (testResult.kind === 'success') {
      void (form.editingServerId ? update() : add())
      return
    }
    if (testResult.kind === 'needs-oauth' && !form.editingServerId) {
      void addAndAuthorize()
    }
  }

  return {
    urlValidation,
    isUrlReady,
    isSaveReady,
    editProbeWaived,
    cancel,
    changeMode,
    add,
    update,
    edit,
    importConfig,
    addAndAuthorize,
    onUrlKeyDown,
    toggleMutation,
    addMutation,
    updateMutation,
    importMutation,
    deleteMutation,
  }
}
