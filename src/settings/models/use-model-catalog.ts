/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useReducer } from 'react'

import type { ComboboxItem } from '@/components/ui/combobox'
import { useDebounce } from '@/hooks/use-debounce'
import {
  canFetchCatalog,
  catalogDebounceMs,
  catalogRequestKey,
  describeModelFetchError,
  fetchModelsForProvider,
  type AvailableModel,
  type CatalogRequest,
} from './model-catalog'

export type ModelCatalogState = {
  models: AvailableModel[]
  requestKey: string | null
  isLoading: boolean
  error: string | null
}

export type ModelCatalogAction =
  | { type: 'CATALOG_REQUESTED'; requestKey: string }
  | { type: 'CATALOG_LOADED'; requestKey: string; models: AvailableModel[] }
  | { type: 'CATALOG_FAILED'; requestKey: string; error: string }
  | { type: 'CATALOG_INVALIDATED' }

export const initialModelCatalogState: ModelCatalogState = {
  models: [],
  requestKey: null,
  isLoading: false,
  error: null,
}

/**
 * Request-key-guarded catalog state machine: results for anything but the
 * most recent request inputs are discarded, so a slow stale response can
 * never overwrite a newer one.
 */
export const modelCatalogReducer = (state: ModelCatalogState, action: ModelCatalogAction): ModelCatalogState => {
  switch (action.type) {
    case 'CATALOG_REQUESTED':
      return { models: [], requestKey: action.requestKey, isLoading: true, error: null }
    case 'CATALOG_LOADED':
      return state.requestKey === action.requestKey ? { ...state, isLoading: false, models: action.models } : state
    case 'CATALOG_FAILED':
      return state.requestKey === action.requestKey
        ? { ...state, isLoading: false, models: [], error: action.error }
        : state
    case 'CATALOG_INVALIDATED':
      return initialModelCatalogState
  }
}

/** The sentinel combobox entry that switches the form into free-text model entry.
 *  Shared by the add and edit forms so the `'custom'` id has one source. */
export const customModelItem: ComboboxItem = { id: 'custom', label: 'Custom' }

/** Maps catalog entries to combobox items (name falls back to the raw id). */
export const catalogToComboboxItems = (models: AvailableModel[]): ComboboxItem[] =>
  models.map((candidate) => ({
    id: candidate.id,
    label: candidate.name || candidate.id,
    description: candidate.name ? candidate.id : undefined,
  }))

/** Provider catalog fetching shared by the add-model and edit-model forms. */
export const useModelCatalog = () => {
  const [state, dispatch] = useReducer(modelCatalogReducer, initialModelCatalogState)

  const fetchCatalog = useCallback(async (request: CatalogRequest) => {
    const requestKey = catalogRequestKey(request)
    dispatch({ type: 'CATALOG_REQUESTED', requestKey })
    try {
      dispatch({ type: 'CATALOG_LOADED', requestKey, models: await fetchModelsForProvider(request) })
    } catch (error) {
      console.error('Failed to fetch models:', error)
      dispatch({ type: 'CATALOG_FAILED', requestKey, error: describeModelFetchError(error) })
    }
  }, [])
  const invalidateCatalog = useCallback(() => dispatch({ type: 'CATALOG_INVALIDATED' }), [])

  return {
    models: state.models,
    requestKey: state.requestKey,
    isLoading: state.isLoading,
    error: state.error,
    fetchCatalog,
    invalidateCatalog,
  }
}

type UseAutoCatalogFetchOptions = {
  /** The caller's arming condition (e.g. panel open, or a fresh key edit). */
  armed: boolean
  request: CatalogRequest
  catalog: Pick<ReturnType<typeof useModelCatalog>, 'requestKey' | 'fetchCatalog'>
}

/**
 * Auto-fetches the provider catalog once the request inputs stop changing.
 * Shared by the add/edit model forms: the request is debounced so
 * credentials and URLs settle before they are sent anywhere, the fetch only
 * fires while `armed` is true and `canFetchCatalog` allows it, and a catalog
 * already requested for the same inputs is never re-fetched.
 */
export const useAutoCatalogFetch = ({ armed, request, catalog }: UseAutoCatalogFetchOptions) => {
  const { requestKey, fetchCatalog } = catalog
  const debouncedRequest = useDebounce(request, catalogDebounceMs)
  const isDebounceSettled = catalogRequestKey(debouncedRequest) === catalogRequestKey(request)
  const hasRequestedCurrentCatalog = requestKey === catalogRequestKey(debouncedRequest)

  useEffect(() => {
    if (!armed || !isDebounceSettled || hasRequestedCurrentCatalog || !canFetchCatalog(debouncedRequest)) {
      return
    }
    void fetchCatalog(debouncedRequest)
  }, [armed, isDebounceSettled, hasRequestedCurrentCatalog, debouncedRequest, fetchCatalog])
}
