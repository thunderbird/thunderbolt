/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { McpServer } from '@/types'
import type { AddServerMode } from './mcp-server-form'

export type ConnectionSelection = { kind: 'integration' | 'server'; id: string } | null

export type ConnectionsPageState = {
  selected: ConnectionSelection
  mode: AddServerMode
  jsonText: string
  importError: string | null
  updateError: string | null
  integrationError: string | null
  pendingDelete: McpServer | null
  retryingServerId: string | null
  isProcessingCallback: boolean
  clearNavigationState: boolean
}

export type ConnectionsPageAction =
  | { type: 'select'; selection: ConnectionSelection }
  | { type: 'set-mode'; mode: AddServerMode }
  | { type: 'set-json'; value: string }
  | { type: 'set-import-error'; error: string | null }
  | { type: 'set-update-error'; error: string | null }
  | { type: 'set-integration-error'; error: string | null }
  | { type: 'confirm-delete'; server: McpServer | null }
  | { type: 'retrying'; serverId: string | null }
  | { type: 'processing-callback'; processing: boolean }
  | { type: 'clear-navigation-state' }
  | { type: 'reset-form' }

export const createConnectionsPageState = (isProcessingCallback = false): ConnectionsPageState => ({
  selected: null,
  mode: 'simple',
  jsonText: '',
  importError: null,
  updateError: null,
  integrationError: null,
  pendingDelete: null,
  retryingServerId: null,
  isProcessingCallback,
  clearNavigationState: false,
})

export const connectionsPageReducer = (
  state: ConnectionsPageState,
  action: ConnectionsPageAction,
): ConnectionsPageState => {
  switch (action.type) {
    case 'select':
      return { ...state, selected: action.selection, integrationError: null }
    case 'set-mode':
      return { ...state, mode: action.mode, importError: null, updateError: null }
    case 'set-json':
      return { ...state, jsonText: action.value }
    case 'set-import-error':
      return { ...state, importError: action.error }
    case 'set-update-error':
      return { ...state, updateError: action.error }
    case 'set-integration-error':
      return { ...state, integrationError: action.error }
    case 'confirm-delete':
      return { ...state, pendingDelete: action.server }
    case 'retrying':
      return { ...state, retryingServerId: action.serverId }
    case 'processing-callback':
      return { ...state, isProcessingCallback: action.processing }
    case 'clear-navigation-state':
      return { ...state, clearNavigationState: true }
    case 'reset-form':
      return { ...state, mode: 'simple', jsonText: '', importError: null, updateError: null }
  }
}
