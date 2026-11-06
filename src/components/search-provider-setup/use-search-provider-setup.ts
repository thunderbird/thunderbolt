/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer, useRef } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useDatabase } from '@/contexts'
import {
  saveProviderConnectionInTransaction,
  disconnectProviderConnection,
  getProviderConnectionRevision,
} from '@/dal/provider-connections'
import { testSearchProvider } from '@/integrations/standalone-search/api'
import { searchProviders, type SearchProvider } from '@/integrations/standalone-search/providers'
import { useSearchProviderStore, type SearchSelection } from '@/stores/search-provider-store'

type State = {
  provider: SearchProvider | null
  apiKey: string
  connectionId: string | null
  status: 'idle' | 'testing' | 'success' | 'error'
  error: string
}

/** Capability refreshes do not supersede the user's selected search route. */
const isCurrentSearchSelection = (expected: { selection: SearchSelection; connectionId: string | null }) => {
  const current = useSearchProviderStore.getState()
  return current.selection === expected.selection && current.connectionId === expected.connectionId
}

/** Verifies onboarding credentials, then saves a reusable connection and selects it for search. */
export const useSearchProviderSetup = (
  onReadyChange?: (ready: boolean) => void,
  onSaved?: () => void,
  testConnection = testSearchProvider,
  initialProvider?: SearchProvider,
) => {
  const { t } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const stored = useSearchProviderStore()
  const [state, update] = useReducer((state: State, patch: Partial<State>) => ({ ...state, ...patch }), {
    provider: initialProvider ?? null,
    apiKey: '',
    connectionId: null,
    status: 'idle',
    error: '',
  })
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const change = (patch: Partial<State>) => {
    pending.current?.abort()
    update({
      ...patch,
      ...(patch.provider && patch.provider !== state.provider ? { connectionId: null } : {}),
      status: 'idle',
      error: '',
    })
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
      const provider = state.provider
      const expectedRevision = state.connectionId
        ? await getProviderConnectionRevision(db, state.connectionId)
        : undefined
      await testConnection(provider, state.apiKey.trim(), controller.signal)
      if (controller.signal.aborted) {
        return
      }
      if (!isCurrentSearchSelection(configuration)) {
        update({ status: 'idle' })
        return
      }
      const connectionId = await db.transaction(async (tx) => {
        const id = await saveProviderConnectionInTransaction(tx, {
          id: state.connectionId ?? undefined,
          provider,
          name: searchProviders[provider].name,
          authMethod: 'api_key',
          expectedRevision,
          signal: controller.signal,
          credentials: { apiKey: state.apiKey.trim() },
        })
        if (controller.signal.aborted || !isCurrentSearchSelection(configuration)) {
          throw new DOMException('Search setup canceled', 'AbortError')
        }
        return id
      })
      stored.selectSearchConnection(connectionId)
      const savedConfiguration = useSearchProviderStore.getState()
      update({ status: 'success', connectionId, apiKey: '' })
      await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
      if (controller.signal.aborted || !isCurrentSearchSelection(savedConfiguration)) {
        return
      }
      onReadyChange?.(true)
      onSaved?.()
    } catch {
      if (controller.signal.aborted) {
        return
      }
      if (!isCurrentSearchSelection(configuration)) {
        update({ status: 'idle' })
        return
      }
      update({ status: 'error', error: t`Could not connect. Check your API key and connection, then try again.` })
    }
  }
  const disconnect = async () => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    try {
      if (state.connectionId) {
        await disconnectProviderConnection(db, state.connectionId)
      }
      if (!controller.signal.aborted) {
        const current = useSearchProviderStore.getState()
        if (state.connectionId && current.connectionId === state.connectionId) {
          current.selectSearchProvider('none')
        }
        change({ apiKey: '', connectionId: null })
      }
      await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
    } catch {
      if (!controller.signal.aborted) {
        update({ status: 'error', error: t`Could not disconnect this search provider. Please try again.` })
      }
    }
  }
  return {
    ...state,
    change,
    test,
    disconnect,
    status: state.status === 'success' && stored.connectionId !== state.connectionId ? 'idle' : state.status,
    hasSavedKey: state.connectionId !== null,
  }
}
