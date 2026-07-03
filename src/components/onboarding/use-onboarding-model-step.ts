/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useReducer } from 'react'
import { useDatabase } from '@/contexts'
import { updateSettings } from '@/dal'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { useActiveUserId } from '@/stores/trust-domain-registry'
import { useFetch } from '@/lib/proxy-fetch-context'
import { useSettings } from '@/hooks/use-settings'
import { isTauri } from '@/lib/platform'
import { getProviderDefinition, type ProviderType } from '@shared/providers'
import { connectProvider } from '@/settings/providers/connect-provider'
import { connectOpenRouterLoopback } from '@/lib/providers/openrouter-oauth'
import { selectDefaultModel } from '@/lib/providers/default-model'
import { enableCatalogModel } from '@/lib/providers/model-catalog'
import { enableFreeModel, tryFreeModel } from '@/lib/providers/free-model'

export type ModelStepStatus = 'idle' | 'connecting' | 'success' | 'error'

export type ModelStepState = {
  type: ProviderType
  apiKey: string
  baseUrl: string
  status: ModelStepStatus
  /** 'provider' for a real connection, 'free' for the free-tier affordance. */
  mode: 'provider' | 'free'
  error: string | null
}

type ModelStepAction =
  | { type: 'SET_TYPE'; providerType: ProviderType; baseUrl: string }
  | { type: 'SET_API_KEY'; apiKey: string }
  | { type: 'SET_BASE_URL'; baseUrl: string }
  | { type: 'START'; mode: 'provider' | 'free' }
  | { type: 'SUCCESS' }
  | { type: 'FAILURE'; error: string }

const makeInitialState = (): ModelStepState => ({
  type: 'openrouter',
  apiKey: '',
  baseUrl: getProviderDefinition('openrouter').defaultBaseUrl ?? '',
  status: 'idle',
  mode: 'provider',
  error: null,
})

const reducer = (state: ModelStepState, action: ModelStepAction): ModelStepState => {
  switch (action.type) {
    case 'SET_TYPE':
      return { ...makeInitialState(), type: action.providerType, baseUrl: action.baseUrl }
    case 'SET_API_KEY':
      return { ...state, apiKey: action.apiKey, status: 'idle', error: null }
    case 'SET_BASE_URL':
      return { ...state, baseUrl: action.baseUrl, status: 'idle', error: null }
    case 'START':
      return { ...state, status: 'connecting', mode: action.mode, error: null }
    case 'SUCCESS':
      return { ...state, status: 'success', error: null }
    case 'FAILURE':
      return { ...state, status: 'error', error: action.error }
    default:
      return state
  }
}

/** Desktop loopback OAuth for OpenRouter → durable API key. */
const runOpenRouterOAuth = (fetchFn: typeof fetch): Promise<string | null> =>
  connectOpenRouterLoopback({
    startServer: () => invoke<number>('start_oauth_server'),
    listenCallback: (handler) => listen<{ url: string }>('oauth-callback', (event) => handler(event.payload.url)),
    openUrl,
    fetchFn,
  })

export type UseOnboardingModelStepResult = {
  state: ModelStepState
  isConnected: boolean
  setType: (type: ProviderType) => void
  setApiKey: (apiKey: string) => void
  setBaseUrl: (baseUrl: string) => void
  /** Connect the selected provider, auto-select a default model, run the hard-gate test. */
  connect: () => Promise<void>
  /** Proceed via the free tier (spec-standalone §8). Resolves true on success. */
  tryFree: () => Promise<boolean>
}

/**
 * Model-provider onboarding step logic (spec-standalone §7 + §9). Encapsulates
 * connect → default-model selection → hard-gate test in a single async handler
 * (no effects), plus the "Try a free model" affordance. Extracted for testing.
 */
export const useOnboardingModelStep = (): UseOnboardingModelStepResult => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const userId = useActiveUserId()
  const proxyFetch = useFetch()
  const { providerSetupSkipped } = useSettings({ provider_setup_skipped: 'false' })
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState)

  const connect = async () => {
    if (!workspaceId || !userId) {
      dispatch({ type: 'FAILURE', error: 'No active workspace or user.' })
      return
    }
    const def = getProviderDefinition(state.type)
    dispatch({ type: 'START', mode: 'provider' })
    try {
      // OAuth providers mint the key via the loopback flow; everything else uses
      // the typed key. Kept as a helper (const) rather than a reassigned `let`.
      const resolveApiKey = async (): Promise<string | undefined> => {
        if (def.connectionType !== 'oauth-pkce') {
          return state.apiKey.trim() || undefined
        }
        if (!isTauri()) {
          throw new Error('OpenRouter sign-in is available on the desktop app for now.')
        }
        return (await runOpenRouterOAuth(proxyFetch)) ?? undefined
      }
      const apiKey = await resolveApiKey()
      if (def.connectionType === 'oauth-pkce' && !apiKey) {
        dispatch({ type: 'FAILURE', error: 'Authorization was cancelled or timed out.' })
        return
      }

      const { providerId, validation } = await connectProvider(
        { db, workspaceId, userId, fetchFn: proxyFetch },
        { type: state.type, apiKey, baseUrl: state.baseUrl },
      )
      if (!validation.ok) {
        dispatch({ type: 'FAILURE', error: validation.error })
        return
      }

      const chosen = await selectDefaultModel(state.type, { apiKey, baseUrl: state.baseUrl }, proxyFetch)
      if (chosen) {
        const rowId = await enableCatalogModel(db, workspaceId, {
          providerId,
          providerType: state.type,
          catalogModel: chosen,
          userId,
        })
        await updateSettings(db, { selected_model: rowId })
      }
      await providerSetupSkipped.setValue('false')
      dispatch({ type: 'SUCCESS' })
    } catch (error) {
      dispatch({ type: 'FAILURE', error: error instanceof Error ? error.message : 'Failed to connect provider.' })
    }
  }

  const tryFree = async (): Promise<boolean> => {
    if (!workspaceId || !userId) {
      dispatch({ type: 'FAILURE', error: 'No active workspace or user.' })
      return false
    }
    dispatch({ type: 'START', mode: 'free' })
    const result = await tryFreeModel(proxyFetch)
    if (!result.ok) {
      dispatch({ type: 'FAILURE', error: result.error })
      return false
    }
    // Persist a usable free model row and select it so the user can chat now.
    const rowId = await enableFreeModel(db, workspaceId, userId)
    await updateSettings(db, { selected_model: rowId })
    await providerSetupSkipped.setValue('false')
    dispatch({ type: 'SUCCESS' })
    return true
  }

  return {
    state,
    isConnected: state.status === 'success',
    setType: (type) =>
      dispatch({ type: 'SET_TYPE', providerType: type, baseUrl: getProviderDefinition(type).defaultBaseUrl ?? '' }),
    setApiKey: (apiKey) => dispatch({ type: 'SET_API_KEY', apiKey }),
    setBaseUrl: (baseUrl) => dispatch({ type: 'SET_BASE_URL', baseUrl }),
    connect,
    tryFree,
  }
}
