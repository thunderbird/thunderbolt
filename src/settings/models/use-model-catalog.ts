/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'

import type { ComboboxItem } from '@/components/ui/combobox'
import {
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

  const fetchCatalog = async (request: CatalogRequest) => {
    const requestKey = catalogRequestKey(request)
    dispatch({ type: 'CATALOG_REQUESTED', requestKey })
    try {
      dispatch({ type: 'CATALOG_LOADED', requestKey, models: await fetchModelsForProvider(request) })
    } catch (error) {
      console.error('Failed to fetch models:', error)
      dispatch({ type: 'CATALOG_FAILED', requestKey, error: describeModelFetchError(error) })
    }
  }

  return {
    models: state.models,
    isLoading: state.isLoading,
    error: state.error,
    fetchCatalog,
    invalidateCatalog: () => dispatch({ type: 'CATALOG_INVALIDATED' }),
  }
}
