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
  | { type: 'SELECTION_CHANGED'; selection: ConnectionSelection }
  | { type: 'MODE_CHANGED'; mode: AddServerMode }
  | { type: 'JSON_CHANGED'; value: string }
  | { type: 'IMPORT_FAILED'; error: string }
  | { type: 'SAVE_STARTED' }
  | { type: 'SAVE_FAILED'; error: string }
  | { type: 'INTEGRATION_FAILED'; error: string }
  | { type: 'INTEGRATION_ERROR_CLEARED' }
  | { type: 'DELETE_REQUESTED'; server: McpServer }
  | { type: 'DELETE_DISMISSED' }
  | { type: 'RETRY_STARTED'; serverId: string }
  | { type: 'RETRY_SETTLED' }
  | { type: 'CALLBACK_STARTED' }
  | { type: 'CALLBACK_SETTLED' }
  | { type: 'NAVIGATION_STATE_CONSUMED' }
  | { type: 'FORM_RESET' }

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
    case 'SELECTION_CHANGED':
      return { ...state, selected: action.selection, integrationError: null }
    case 'MODE_CHANGED':
      return { ...state, mode: action.mode, importError: null, updateError: null }
    case 'JSON_CHANGED':
      return { ...state, jsonText: action.value }
    case 'IMPORT_FAILED':
      return { ...state, importError: action.error }
    case 'SAVE_STARTED':
      return { ...state, updateError: null }
    case 'SAVE_FAILED':
      return { ...state, updateError: action.error }
    case 'INTEGRATION_FAILED':
      return { ...state, integrationError: action.error }
    case 'INTEGRATION_ERROR_CLEARED':
      return { ...state, integrationError: null }
    case 'DELETE_REQUESTED':
      return { ...state, pendingDelete: action.server }
    case 'DELETE_DISMISSED':
      return { ...state, pendingDelete: null }
    case 'RETRY_STARTED':
      return { ...state, retryingServerId: action.serverId }
    case 'RETRY_SETTLED':
      return { ...state, retryingServerId: null }
    case 'CALLBACK_STARTED':
      return { ...state, isProcessingCallback: true }
    case 'CALLBACK_SETTLED':
      return { ...state, isProcessingCallback: false }
    case 'NAVIGATION_STATE_CONSUMED':
      return { ...state, clearNavigationState: true }
    case 'FORM_RESET':
      return { ...state, mode: 'simple', jsonText: '', importError: null, updateError: null }
  }
}
