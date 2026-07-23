/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AvailableModel } from './model-catalog'

export type ModelPanel = { kind: 'add' } | { kind: 'detail' | 'edit'; modelId: string } | null

export type ModelsPageState = {
  panel: ModelPanel
  deleteConfirmId: string | null
  catalog: AvailableModel[]
  catalogRequestKey: string | null
  loadingCatalog: boolean
  catalogError: string | null
  selectedModelId: string
}

export type ModelsPageAction =
  | { type: 'open-panel'; panel: ModelPanel }
  | { type: 'confirm-delete'; modelId: string | null }
  | { type: 'catalog-loading'; requestKey: string }
  | { type: 'catalog-loaded'; requestKey: string; models: AvailableModel[] }
  | { type: 'catalog-failed'; requestKey: string; error: string }
  | { type: 'invalidate-catalog' }
  | { type: 'select-model'; modelId: string }

export const initialModelsPageState: ModelsPageState = {
  panel: null,
  deleteConfirmId: null,
  catalog: [],
  catalogRequestKey: null,
  loadingCatalog: false,
  catalogError: null,
  selectedModelId: '',
}

export const modelsPageReducer = (state: ModelsPageState, action: ModelsPageAction): ModelsPageState => {
  switch (action.type) {
    case 'open-panel':
      return { ...state, panel: action.panel }
    case 'confirm-delete':
      return { ...state, deleteConfirmId: action.modelId }
    case 'catalog-loading':
      return {
        ...state,
        loadingCatalog: true,
        catalog: [],
        catalogError: null,
        catalogRequestKey: action.requestKey,
      }
    case 'catalog-loaded':
      return state.catalogRequestKey === action.requestKey
        ? { ...state, loadingCatalog: false, catalog: action.models }
        : state
    case 'catalog-failed':
      return state.catalogRequestKey === action.requestKey
        ? { ...state, loadingCatalog: false, catalog: [], catalogError: action.error }
        : state
    case 'invalidate-catalog':
      return { ...state, catalog: [], catalogRequestKey: null, loadingCatalog: false, catalogError: null }
    case 'select-model':
      return { ...state, selectedModelId: action.modelId }
  }
}
