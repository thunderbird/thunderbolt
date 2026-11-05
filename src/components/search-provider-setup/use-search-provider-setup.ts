/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer, useRef } from 'react'
import { useLingui } from '@lingui/react/macro'
import { testSearchProvider } from '@/integrations/standalone-search/api'
import type { SearchProvider } from '@/integrations/standalone-search/providers'
import { useSearchProviderStore } from '@/stores/search-provider-store'

type State = {
  provider: SearchProvider | null
  apiKey: string
  status: 'idle' | 'testing' | 'success' | 'error'
  error: string
}

/** Saves only verified credentials and cancels stale tests when inputs or screens change. */
export const useSearchProviderSetup = (
  onReadyChange?: (ready: boolean) => void,
  onSaved?: () => void,
  testConnection = testSearchProvider,
  initialProvider?: SearchProvider,
) => {
  const { t } = useLingui()
  const stored = useSearchProviderStore()
  const [state, update] = useReducer((state: State, patch: Partial<State>) => ({ ...state, ...patch }), {
    provider: initialProvider ?? stored.provider,
    apiKey: !initialProvider || initialProvider === stored.provider ? stored.apiKey : '',
    status: stored.apiKey && (!initialProvider || initialProvider === stored.provider) ? 'success' : 'idle',
    error: '',
  })
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const change = (patch: Partial<State>) => {
    pending.current?.abort()
    update({ ...patch, status: 'idle', error: '' })
    onReadyChange?.(false)
  }
  const test = async () => {
    if (!state.provider || !state.apiKey.trim() || state.status === 'testing') {
      return
    }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    const configuration = useSearchProviderStore.getState()
    update({ status: 'testing', error: '' })
    onReadyChange?.(false)
    try {
      await testConnection(state.provider, state.apiKey.trim(), controller.signal)
      if (controller.signal.aborted) {
        return
      }
      // A disconnect, reset, or selection in another window supersedes this test.
      if (useSearchProviderStore.getState() !== configuration) {
        update({ status: 'idle' })
        return
      }
      stored.configureSearchProvider(state.apiKey, state.provider)
      update({ status: 'success' })
      onReadyChange?.(true)
      onSaved?.()
    } catch {
      if (controller.signal.aborted) {
        return
      }
      update({ status: 'error', error: t`Could not connect. Check your API key and connection, then try again.` })
    }
  }
  const disconnect = () => {
    stored.disconnectSearchProvider()
    change({ apiKey: '' })
  }
  return {
    ...state,
    // Another window may disconnect or replace credentials after a successful test.
    status:
      state.status === 'success' && (stored.provider !== state.provider || stored.apiKey !== state.apiKey.trim())
        ? 'idle'
        : state.status,
    change,
    test,
    disconnect,
    hasSavedKey: Boolean(stored.apiKey && stored.provider === state.provider),
  }
}
