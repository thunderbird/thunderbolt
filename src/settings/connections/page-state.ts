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
  addError: string | null
  updateError: string | null
  integrationError: string | null
  /** A failed action on one MCP server (e.g. retry), surfaced in that server's detail panel. */
  serverError: { serverId: string; message: string } | null
  pendingDelete: McpServer | null
  retryingServerId: string | null
  isProcessingCallback: boolean
  shouldClearNavigationState: boolean
}

export type ConnectionsPageAction =
  | { type: 'SELECTION_CHANGED'; selection: ConnectionSelection }
  | { type: 'MODE_CHANGED'; mode: AddServerMode }
  | { type: 'JSON_CHANGED'; value: string }
  | { type: 'IMPORT_FAILED'; error: string }
  | { type: 'ADD_FAILED'; error: string }
  | { type: 'SAVE_STARTED' }
  | { type: 'SAVE_FAILED'; error: string }
  | { type: 'INTEGRATION_FAILED'; error: string }
  | { type: 'INTEGRATION_ERROR_CLEARED' }
  | { type: 'SERVER_FAILED'; serverId: string; error: string }
  | { type: 'DELETE_REQUESTED'; server: McpServer }
  | { type: 'DELETE_DISMISSED' }
  | { type: 'RETRY_STARTED'; serverId: string }
  | { type: 'RETRY_SETTLED' }
  | { type: 'CALLBACK_STARTED' }
  | { type: 'CALLBACK_SETTLED' }
  | { type: 'NAVIGATION_STATE_CONSUMED' }
  | { type: 'FORM_RESET' }

/** Builds the page's initial reducer state; `isProcessingCallback` seeds true when the
 *  page mounts from an in-flight integration OAuth redirect so the spinner shows immediately. */
export const createConnectionsPageState = (isProcessingCallback = false): ConnectionsPageState => ({
  selected: null,
  mode: 'simple',
  jsonText: '',
  importError: null,
  addError: null,
  updateError: null,
  integrationError: null,
  serverError: null,
  pendingDelete: null,
  retryingServerId: null,
  isProcessingCallback,
  shouldClearNavigationState: false,
})

/** Reducer for the Connections page's panel selection, form modes, and error channels. */
export const connectionsPageReducer = (
  state: ConnectionsPageState,
  action: ConnectionsPageAction,
): ConnectionsPageState => {
  switch (action.type) {
    case 'SELECTION_CHANGED':
      return { ...state, selected: action.selection, integrationError: null, serverError: null }
    case 'MODE_CHANGED':
      return { ...state, mode: action.mode, importError: null, addError: null, updateError: null }
    case 'JSON_CHANGED':
      return { ...state, jsonText: action.value }
    case 'IMPORT_FAILED':
      return { ...state, importError: action.error }
    case 'ADD_FAILED':
      return { ...state, addError: action.error }
    case 'SAVE_STARTED':
      return { ...state, updateError: null }
    case 'SAVE_FAILED':
      return { ...state, updateError: action.error }
    case 'INTEGRATION_FAILED':
      return { ...state, integrationError: action.error }
    case 'INTEGRATION_ERROR_CLEARED':
      return { ...state, integrationError: null }
    case 'SERVER_FAILED':
      return { ...state, serverError: { serverId: action.serverId, message: action.error } }
    case 'DELETE_REQUESTED':
      return { ...state, pendingDelete: action.server }
    case 'DELETE_DISMISSED':
      return { ...state, pendingDelete: null }
    case 'RETRY_STARTED':
      return { ...state, retryingServerId: action.serverId, serverError: null }
    case 'RETRY_SETTLED':
      return { ...state, retryingServerId: null }
    case 'CALLBACK_STARTED':
      return { ...state, isProcessingCallback: true }
    case 'CALLBACK_SETTLED':
      return { ...state, isProcessingCallback: false }
    case 'NAVIGATION_STATE_CONSUMED':
      return { ...state, shouldClearNavigationState: true }
    case 'FORM_RESET':
      return { ...state, mode: 'simple', jsonText: '', importError: null, addError: null, updateError: null }
  }
}
