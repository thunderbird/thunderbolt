/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useReducer } from 'react'
import { useDatabase } from '@/contexts'
import type { ResourceScope } from '@/components/scope-picker'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { useActiveUserId } from '@/stores/trust-domain-registry'
import { useFetch } from '@/lib/proxy-fetch-context'
import { isTauri } from '@/lib/platform'
import { connectOpenRouterLoopback } from '@/lib/providers/openrouter-oauth'
import { getProviderDefinition, type ProviderType } from '@shared/providers'
import { connectProvider } from './connect-provider'

export type ConnectStatus = 'idle' | 'connecting' | 'success' | 'error'

export type ConnectState = {
  /** Provider type whose connect dialog is open; `null` means closed. */
  type: ProviderType | null
  apiKey: string
  baseUrl: string
  scope: ResourceScope
  status: ConnectStatus
  error: string | null
}

export type ConnectAction =
  | { type: 'OPEN'; providerType: ProviderType; baseUrl: string; scope: ResourceScope }
  | { type: 'CLOSE' }
  | { type: 'SET_API_KEY'; apiKey: string }
  | { type: 'SET_BASE_URL'; baseUrl: string }
  | { type: 'SET_SCOPE'; scope: ResourceScope }
  | { type: 'START' }
  | { type: 'SUCCESS' }
  | { type: 'FAILURE'; error: string }

export const initialConnectState: ConnectState = {
  type: null,
  apiKey: '',
  baseUrl: '',
  scope: 'workspace',
  status: 'idle',
  error: null,
}

/** Pure reducer for the connect-provider dialog. Exported for unit testing. */
export const connectReducer = (state: ConnectState, action: ConnectAction): ConnectState => {
  switch (action.type) {
    case 'OPEN':
      return { ...initialConnectState, type: action.providerType, baseUrl: action.baseUrl, scope: action.scope }
    case 'CLOSE':
      return initialConnectState
    case 'SET_API_KEY':
      return { ...state, apiKey: action.apiKey }
    case 'SET_BASE_URL':
      return { ...state, baseUrl: action.baseUrl }
    case 'SET_SCOPE':
      return { ...state, scope: action.scope }
    case 'START':
      return { ...state, status: 'connecting', error: null }
    case 'SUCCESS':
      return { ...state, status: 'success', error: null }
    case 'FAILURE':
      return { ...state, status: 'error', error: action.error }
    default:
      return state
  }
}

/** Desktop loopback OAuth for OpenRouter, wiring the Tauri/browser primitives. */
const runOpenRouterOAuth = async (fetchFn: typeof fetch): Promise<string | null> =>
  connectOpenRouterLoopback({
    startServer: () => invoke<number>('start_oauth_server'),
    listenCallback: (handler) => listen<{ url: string }>('oauth-callback', (event) => handler(event.payload.url)),
    openUrl,
    fetchFn,
  })

export type UseConnectProviderResult = {
  state: ConnectState
  open: (providerType: ProviderType) => void
  close: () => void
  setApiKey: (apiKey: string) => void
  setBaseUrl: (baseUrl: string) => void
  setScope: (scope: ResourceScope) => void
  submit: () => Promise<void>
}

/**
 * Drives the connect-provider dialog: form fields, connection status, and the
 * connect→validate orchestration. Branches by the catalog `connectionType`
 * (api-key / url / oauth-pkce). OpenRouter OAuth is desktop-only for launch.
 */
export const useConnectProvider = (): UseConnectProviderResult => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const userId = useActiveUserId()
  const proxyFetch = useFetch()
  const [state, dispatch] = useReducer(connectReducer, initialConnectState)

  const open = (providerType: ProviderType) => {
    const def = getProviderDefinition(providerType)
    dispatch({ type: 'OPEN', providerType, baseUrl: def.defaultBaseUrl ?? '', scope: 'workspace' })
  }

  const submit = async () => {
    if (!state.type || !workspaceId || !userId) {
      dispatch({ type: 'FAILURE', error: 'No active workspace or user.' })
      return
    }
    const def = getProviderDefinition(state.type)
    dispatch({ type: 'START' })

    try {
      const apiKey = await resolveApiKey(def.connectionType, state.apiKey, proxyFetch)
      if (def.connectionType === 'oauth-pkce' && !apiKey) {
        dispatch({ type: 'FAILURE', error: 'Authorization was cancelled or timed out.' })
        return
      }

      const { validation } = await connectProvider(
        { db, workspaceId, userId, fetchFn: proxyFetch },
        { type: state.type, apiKey, baseUrl: state.baseUrl, scope: state.scope },
      )
      dispatch(validation.ok ? { type: 'SUCCESS' } : { type: 'FAILURE', error: validation.error })
    } catch (error) {
      dispatch({ type: 'FAILURE', error: error instanceof Error ? error.message : 'Failed to connect provider.' })
    }
  }

  return {
    state,
    open,
    close: () => dispatch({ type: 'CLOSE' }),
    setApiKey: (apiKey) => dispatch({ type: 'SET_API_KEY', apiKey }),
    setBaseUrl: (baseUrl) => dispatch({ type: 'SET_BASE_URL', baseUrl }),
    setScope: (scope) => dispatch({ type: 'SET_SCOPE', scope }),
    submit,
  }
}

/** Resolve the credential to store: OAuth exchanges for a key; others use the typed key. */
const resolveApiKey = async (
  connectionType: ReturnType<typeof getProviderDefinition>['connectionType'],
  typedKey: string,
  fetchFn: typeof fetch,
): Promise<string | undefined> => {
  if (connectionType === 'oauth-pkce') {
    if (!isTauri()) {
      throw new Error('OpenRouter sign-in is available on the desktop app for now.')
    }
    return (await runOpenRouterOAuth(fetchFn)) ?? undefined
  }
  return typedKey.trim() || undefined
}
