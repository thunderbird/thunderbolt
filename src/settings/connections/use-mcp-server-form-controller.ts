/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { type Dispatch, type KeyboardEvent } from 'react'
import { useAsyncAttempt } from '@/hooks/use-async-attempt'
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
import { fireAndForgetSelfEnrollment } from '@/lib/iroh-enrollment'
import { parseMcpServersConfig, type ParsedMcpServer } from '@/lib/mcp-config-import'
import type { useMCP } from '@/lib/mcp-provider'
import type { MCPTransportType } from '@/lib/mcp-transport'
import { validateMcpServerUrl } from '@/lib/mcp-url-validation'
import { useReportConnectionEvent } from '@/lib/report-connection-event'
import type { McpServer } from '@/types'
import type { AddServerMode } from './mcp-server-form'
import type { ConnectionsPageAction } from './page-state'

const serverGone = msg`This server no longer exists. It may have been removed on another device.`
const reconnectFailed = msg`Changes were saved, but reconnecting failed. Please retry.`

/** The audit log's name for each way an MCP server authenticates. */
export const mcpAuthMethods = { oauth: 'oauth', bearer: 'api_key', none: 'none' } as const

/** Whether a server is left with a bearer credential: a token, or a credential object. */
const credentialTypeOf = (credential: unknown): StoredCredentialType => (credential ? 'bearer' : 'none')

/**
 * Maps the edit form's credential tri-state to DAL semantics: a typed token
 * replaces, an explicit clear of a stored bearer deletes (`null`), and an
 * untouched empty field keeps whatever is stored (`undefined`).
 */
export const resolveCredentialUpdate = (
  nextToken: string,
  isClearingStoredToken: boolean,
  originalCredentialType: StoredCredentialType,
): { type: 'bearer'; token: string } | null | undefined => {
  if (nextToken) {
    return { type: 'bearer', token: nextToken }
  }
  return isClearingStoredToken && originalCredentialType === 'bearer' ? null : undefined
}

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
  const { i18n, t } = useLingui()
  const submission = useAsyncAttempt()
  const reportConnectionEvent = useReportConnectionEvent()
  const reportServer = (
    action: Parameters<typeof reportConnectionEvent>[0]['action'],
    id: string,
    credentialType: StoredCredentialType,
  ) => reportConnectionEvent({ action, target: { type: 'mcp_server', id }, authMethod: mcpAuthMethods[credentialType] })
  const { url, isIroh, token, testResult, resolveServerName } = form
  const urlValidation = !isIroh && url ? validateMcpServerUrl(url) : null
  const isUrlReady = Boolean(url) && urlValidation?.ok === true
  const isSaveReady = isIroh ? resolveServerName().length > 0 : isUrlReady
  const isEditProbeWaived = isIroh || !form.hasConnectionEdits || form.isClearingBearerOnly || form.isOAuthEdit

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateMcpServerEnabled(db, id, enabled),
    onError: (error) =>
      dispatch({
        type: 'INTEGRATION_FAILED',
        error: error instanceof Error ? error.message : t`Failed to update MCP server`,
      }),
  })
  const addMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      serverUrl,
      transport,
      bearerToken,
      oauth = false,
    }: {
      id: string
      name: string
      serverUrl: string
      transport: MCPTransportType
      bearerToken: string
      /** The server is added to be authorized by OAuth next. */
      oauth?: boolean
    }) => {
      await createMcpServerWithCredentials(
        db,
        { id, name, url: serverUrl, type: transport, enabled: 1 },
        bearerToken ? { type: 'bearer', token: bearerToken } : undefined,
      )
      reportServer('user_connection.added', id, oauth ? 'oauth' : credentialTypeOf(bearerToken))
    },
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
      const credentials = resolveCredentialUpdate(nextToken, isClearingStoredToken, originalCredentialType)
      await updateMcpServerWithCredentials(db, id, { name, url: serverUrl, type: transport }, credentials)
      const credentialType = credentials === undefined ? originalCredentialType : credentialTypeOf(credentials)
      reportServer('user_connection.updated', id, credentialType)
      if (credentials !== undefined) {
        reportServer('user_connection.credential_replaced', id, credentialType)
      }
    },
  })
  const importMutation = useMutation({
    mutationFn: async (parsed: ParsedMcpServer[]) => {
      const servers = parsed.map((server) => ({
        server: {
          id: uuidv7(),
          name: server.name,
          url: server.url,
          type: server.transport,
          enabled: server.enabled ? 1 : 0,
        },
        credential: server.credential,
      }))
      await createMcpServersWithCredentials(db, servers)
      for (const { server, credential } of servers) {
        reportServer('user_connection.added', server.id, credentialTypeOf(credential))
      }
    },
  })
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await deleteMcpServer(db, id)
      reportServer('user_connection.removed', id, credentialsById[id]?.type ?? 'none')
    },
    onSuccess: () => dispatch({ type: 'DELETE_DISMISSED' }),
    onError: (error) =>
      dispatch({
        type: 'INTEGRATION_FAILED',
        error: error instanceof Error ? error.message : t`Failed to remove MCP server`,
      }),
  })

  const cancel = () => {
    submission.cancel()
    form.resetAddForm()
    dispatch({ type: 'FORM_RESET' })
  }
  const changeMode = (mode: AddServerMode) => {
    submission.cancel()
    clearDialogError()
    dispatch({ type: 'MODE_CHANGED', mode })
  }
  const add = async () => {
    if (!isSaveReady) {
      return
    }
    const attempt = submission.begin()
    if (!attempt) {
      return
    }
    try {
      const serverUrl = isIroh ? url.trim() : url
      await addMutation.mutateAsync({
        id: uuidv7(),
        name: resolveServerName(),
        serverUrl,
        transport: form.transport,
        bearerToken: token,
      })
      if (isIroh) {
        // App enrolls its own dialer NodeId; bridge registers itself server-side.
        fireAndForgetSelfEnrollment(enrollIroh)
      }
      if (attempt.isCurrent()) {
        cancel()
      }
    } catch (error) {
      console.error('Failed to add MCP server:', error)
      if (attempt.isCurrent()) {
        dispatch({ type: 'ADD_FAILED', error: "Couldn't add the server. Please try again." })
      }
    } finally {
      attempt.finish()
    }
  }
  const update = async () => {
    if (!form.editingServerId || !isSaveReady) {
      return
    }
    const id = form.editingServerId
    const row = servers.find((server) => server.id === id)
    if (!row) {
      // The edit form can only open from an existing row; a miss means state
      // corruption (or the row was deleted on another device mid-edit). Surface
      // it in the form like every other save failure instead of throwing into
      // the voided onClick promise.
      console.error(`MCP server ${id} is being edited but no longer exists`)
      dispatch({
        type: 'SAVE_FAILED',
        error: i18n._(serverGone),
      })
      return
    }
    const attempt = submission.begin()
    if (!attempt) {
      return
    }
    const name = resolveServerName()
    const transport = form.transport
    const enabled = row.enabled === 1
    const serverUrl = isIroh ? url.trim() : url
    dispatch({ type: 'SAVE_STARTED' })
    try {
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
        if (attempt.isCurrent()) {
          dispatch({ type: 'SAVE_FAILED', error: "Couldn't save changes. Please try again." })
        }
        return
      }
      if (!attempt.isCurrent()) {
        return
      }
      try {
        await updateLiveServer(
          { id, name, url: serverUrl, type: transport, enabled },
          { forceRedial: form.hasConnectionEdits },
        )
      } catch (error) {
        console.error('Failed to update live MCP server:', error)
        if (attempt.isCurrent()) {
          dispatch({ type: 'SAVE_FAILED', error: i18n._(reconnectFailed) })
        }
        return
      }
      if (attempt.isCurrent()) {
        cancel()
      }
    } finally {
      attempt.finish()
    }
  }

  const edit = (server: McpServer) => {
    submission.cancel()
    const credential = credentialsById[server.id]
    dispatch({ type: 'SELECTION_CHANGED', selection: { kind: 'server', id: server.id } })
    form.openEditForm(server, credential?.bearerToken ?? null, credential?.type ?? 'none')
  }
  const importConfig = async () => {
    const result = parseMcpServersConfig(jsonText)
    if (!result.ok) {
      dispatch({ type: 'IMPORT_FAILED', error: result.errors.join('\n') })
      return
    }
    const attempt = submission.begin()
    if (!attempt) {
      return
    }
    try {
      await importMutation.mutateAsync(result.servers)
      if (attempt.isCurrent()) {
        cancel()
      }
    } catch (error) {
      console.error('Failed to import MCP servers:', error)
      if (attempt.isCurrent()) {
        dispatch({ type: 'IMPORT_FAILED', error: "Couldn't import servers. Please try again." })
      }
    } finally {
      attempt.finish()
    }
  }
  const addAndAuthorize = async () => {
    if (!isUrlReady) {
      return
    }
    const attempt = submission.begin()
    if (!attempt) {
      return
    }
    try {
      const id = uuidv7()
      const started = await startAddAndAuthorize({
        serverId: id,
        serverUrl: url,
        createRow: () =>
          addMutation.mutateAsync({
            id,
            name: resolveServerName(),
            serverUrl: url,
            transport: form.transport,
            bearerToken: token,
            oauth: true,
          }),
      })
      if (started && attempt.isCurrent()) {
        cancel()
      }
    } finally {
      attempt.finish()
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
    if (form.editingServerId && isSaveReady && isEditProbeWaived) {
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
    isEditProbeWaived,
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
