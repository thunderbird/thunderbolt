/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { useDatabase } from '@/contexts'
import { useActiveWorkspaceId } from '@/lib/active-workspace'
import { useActiveUserId } from '@/stores/trust-domain-registry'
import { useFetch } from '@/lib/proxy-fetch-context'
import { useSettings } from '@/hooks/use-settings'
import { getProviderDefinition, type ProviderType } from '@shared/providers'
import { connectProvider } from '@/settings/providers/connect-provider'

export type SearchStepStatus = 'idle' | 'connecting' | 'success' | 'error'

export type SearchStepState = {
  type: ProviderType
  apiKey: string
  baseUrl: string
  status: SearchStepStatus
  error: string | null
}

type SearchStepAction =
  | { type: 'SET_TYPE'; providerType: ProviderType; baseUrl: string }
  | { type: 'SET_API_KEY'; apiKey: string }
  | { type: 'SET_BASE_URL'; baseUrl: string }
  | { type: 'START' }
  | { type: 'SUCCESS' }
  | { type: 'FAILURE'; error: string }

const makeInitialState = (): SearchStepState => ({
  type: 'exa',
  apiKey: '',
  baseUrl: getProviderDefinition('exa').defaultBaseUrl ?? '',
  status: 'idle',
  error: null,
})

const reducer = (state: SearchStepState, action: SearchStepAction): SearchStepState => {
  switch (action.type) {
    case 'SET_TYPE':
      return { ...makeInitialState(), type: action.providerType, baseUrl: action.baseUrl }
    case 'SET_API_KEY':
      return { ...state, apiKey: action.apiKey, status: 'idle', error: null }
    case 'SET_BASE_URL':
      return { ...state, baseUrl: action.baseUrl, status: 'idle', error: null }
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

export type UseOnboardingSearchStepResult = {
  state: SearchStepState
  isConnected: boolean
  setType: (type: ProviderType) => void
  setApiKey: (apiKey: string) => void
  setBaseUrl: (baseUrl: string) => void
  /** Connect + hard-gate test search, then set `search_provider_id`. */
  connect: () => Promise<void>
}

/**
 * Search-provider onboarding step logic (spec-standalone §8). Reuses
 * {@link connectProvider} (which persists the row + runs a live test search as
 * the hard gate) and, on success, sets `search_provider_id`. DuckDuckGo (free)
 * is just a keyless provider row here. Extracted for testing.
 */
export const useOnboardingSearchStep = (): UseOnboardingSearchStepResult => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const userId = useActiveUserId()
  const proxyFetch = useFetch()
  const { searchProviderId, providerSetupSkipped } = useSettings({
    search_provider_id: '',
    provider_setup_skipped: 'false',
  })
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState)

  const connect = async () => {
    if (!workspaceId || !userId) {
      dispatch({ type: 'FAILURE', error: 'No active workspace or user.' })
      return
    }
    dispatch({ type: 'START' })
    try {
      const { providerId, validation } = await connectProvider(
        { db, workspaceId, userId, fetchFn: proxyFetch },
        { type: state.type, apiKey: state.apiKey.trim() || undefined, baseUrl: state.baseUrl },
      )
      if (!validation.ok) {
        dispatch({ type: 'FAILURE', error: validation.error })
        return
      }
      await searchProviderId.setValue(providerId)
      await providerSetupSkipped.setValue('false')
      dispatch({ type: 'SUCCESS' })
    } catch (error) {
      dispatch({
        type: 'FAILURE',
        error: error instanceof Error ? error.message : 'Failed to connect search provider.',
      })
    }
  }

  return {
    state,
    isConnected: state.status === 'success',
    setType: (type) =>
      dispatch({ type: 'SET_TYPE', providerType: type, baseUrl: getProviderDefinition(type).defaultBaseUrl ?? '' }),
    setApiKey: (apiKey) => dispatch({ type: 'SET_API_KEY', apiKey }),
    setBaseUrl: (baseUrl) => dispatch({ type: 'SET_BASE_URL', baseUrl }),
    connect,
  }
}
