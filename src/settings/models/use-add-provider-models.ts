/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useProviderVisibility } from '@/providers/use-provider-visibility'
import { useCallback, useDeferredValue, useEffect, useReducer, useRef } from 'react'
import { useLingui } from '@lingui/react/macro'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery as usePowerSyncQuery } from '@powersync/tanstack-react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/chats/chat-store'
import { useDatabase } from '@/contexts'
import { getAllModels, getAvailableModels } from '@/dal'
import { getProviderConnections } from '@/dal/provider-connections'
import { addProviderModels, fetchProviderModels } from '@/providers/models'
import { getProviderDefinition } from '@/providers/registry'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import type { AvailableModel } from './model-catalog'
import { getModelDisplayName } from './model-display-name'

type PickerState = {
  connectionId: string
  selected: string[]
  search: string
  manualId: string
  manual: boolean
}
const initialState: PickerState = {
  connectionId: '',
  selected: [],
  search: '',
  manualId: '',
  manual: false,
}
type PickerAction =
  | { type: 'connection'; id: string }
  | { type: 'toggle'; id: string }
  | { type: 'search'; value: string }
  | { type: 'manual'; value: boolean }
  | { type: 'manualId'; value: string }
  | { type: 'reset' }

/** Keeps catalog selections scoped to the connection that supplied them. */
export const providerModelPickerReducer = (state: PickerState, action: PickerAction): PickerState => {
  switch (action.type) {
    case 'connection':
      return { ...initialState, connectionId: action.id }
    case 'toggle':
      return {
        ...state,
        selected: state.selected.includes(action.id)
          ? state.selected.filter((id) => id !== action.id)
          : [...state.selected, action.id],
      }
    case 'search':
      return { ...state, search: action.value }
    case 'manual':
      return { ...state, manual: action.value }
    case 'manualId':
      return { ...state, manualId: action.value }
    case 'reset':
      return initialState
  }
}

/** Loads a connected provider's catalog and saves the selected models together. */
export const useAddProviderModels = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const { t } = useLingui()
  const db = useDatabase()
  const { isProviderVisible } = useProviderVisibility()
  const getProxyFetch = useProxyFetchGetter()
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(providerModelPickerReducer, initialState)
  const toggleModel = useCallback((id: string) => dispatch({ type: 'toggle', id }), [])
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  const { data: allConnections = [], isLoading } = usePowerSyncQuery({
    queryKey: ['provider-connections'],
    query: toCompilableQuery(getProviderConnections(db)),
  })
  const { data: savedModels = [] } = usePowerSyncQuery({
    queryKey: ['models', 'provider-picker'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const connections = allConnections.filter(
    (connection) =>
      isProviderVisible(connection.provider) &&
      getProviderDefinition(connection.provider).capabilities.includes('models'),
  )
  const connection = connections.find((candidate) => candidate.id === state.connectionId)
  const canLoad = Boolean(isOpen && connection?.connected && connection.enabled)
  const catalog = useQuery({
    queryKey: ['provider-models', connection?.id, connection?.updatedAt],
    queryFn: () => fetchProviderModels(db, connection!.id, getProxyFetch),
    enabled: canLoad,
    retry: false,
  })
  const models = catalog.data ?? []
  const existingIds = new Set(
    savedModels.filter((model) => model.providerConnectionId === connection?.id).map((model) => model.model),
  )
  const search = useDeferredValue(state.search.trim().toLocaleLowerCase())
  const visibleModels = models.filter((model) =>
    `${getModelDisplayName(model)} ${model.id}`.toLocaleLowerCase().includes(search),
  )
  const selectedModels: AvailableModel[] = state.manual
    ? state.manualId.trim() && !existingIds.has(state.manualId.trim())
      ? [{ id: state.manualId.trim() }]
      : []
    : models.filter((model) => state.selected.includes(model.id) && !existingIds.has(model.id))
  const mutation = useMutation({
    mutationFn: async ({
      id,
      models,
      updatedAt,
      controller,
    }: {
      id: string
      models: AvailableModel[]
      updatedAt: string
      controller: AbortController
    }) => {
      await addProviderModels(db, id, models, { expectedUpdatedAt: updatedAt, signal: controller.signal })
      const availableModels = await getAvailableModels(db)
      controller.signal.throwIfAborted()
      useChatStore.getState().setModels(availableModels)
      await queryClient.invalidateQueries({ queryKey: ['models'] })
    },
    onSuccess: (_result, { controller }) => {
      if (controller.signal.aborted) {
        return
      }
      dispatch({ type: 'reset' })
      onClose()
    },
    onSettled: (_result, _error, { controller }) => {
      if (pending.current === controller) {
        pending.current = null
      }
    },
  })
  const resetForm = () => {
    pending.current?.abort()
    pending.current = null
    dispatch({ type: 'reset' })
    mutation.reset()
  }
  const canSubmit =
    canLoad &&
    selectedModels.length > 0 &&
    !mutation.isPending &&
    (state.manual || (!catalog.isFetching && !catalog.isError))
  return {
    ...state,
    connections,
    connection,
    isLoading,
    canLoad,
    visibleModels,
    existingIds,
    selectedCount: selectedModels.length,
    modelsWithoutTools: selectedModels.filter((model) => model.supports_tools === false).map(getModelDisplayName),
    isLoadingCatalog: canLoad && catalog.isFetching,
    catalogError: catalog.isError ? t`Could not load this connection's models. Try again.` : null,
    submitError: mutation.isError ? t`Could not add the models. Try again.` : null,
    isPending: mutation.isPending,
    canSubmit,
    changeConnection: (id: string) => {
      resetForm()
      dispatch({ type: 'connection', id })
    },
    toggleModel,
    setSearch: (value: string) => dispatch({ type: 'search', value }),
    setManual: (value: boolean) => dispatch({ type: 'manual', value }),
    setManualId: (value: string) => dispatch({ type: 'manualId', value }),
    refresh: () => void catalog.refetch(),
    submit: () => {
      if (canSubmit && connection && !pending.current) {
        const controller = new AbortController()
        pending.current = controller
        mutation.mutate({
          id: connection.id,
          models: selectedModels,
          updatedAt: connection.updatedAt,
          controller,
        })
      }
    },
    onCancel: () => {
      resetForm()
      onClose()
    },
    resetForm,
    prepareForOpen: resetForm,
  }
}
