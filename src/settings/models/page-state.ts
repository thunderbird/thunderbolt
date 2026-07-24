/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type ModelPanel = { kind: 'add' } | { kind: 'detail' | 'edit'; modelId: string } | null

export type ModelsPageState = {
  panel: ModelPanel
  deleteConfirmId: string | null
  selectedModelId: string
  /** User-facing message from the most recent failed DAL mutation. */
  mutationError: string | null
}

export type ModelsPageAction =
  | { type: 'PANEL_CHANGED'; panel: ModelPanel }
  | { type: 'DELETE_REQUESTED'; modelId: string }
  | { type: 'DELETE_DISMISSED' }
  | { type: 'MODEL_SELECTED'; modelId: string }
  | { type: 'MUTATION_FAILED'; error: string }
  | { type: 'MUTATION_STARTED' }

export const initialModelsPageState: ModelsPageState = {
  panel: null,
  deleteConfirmId: null,
  selectedModelId: '',
  mutationError: null,
}

/** Reducer for the Models page's panel, delete confirmation, add-form model pick, and mutation error. */
export const modelsPageReducer = (state: ModelsPageState, action: ModelsPageAction): ModelsPageState => {
  switch (action.type) {
    case 'PANEL_CHANGED':
      return { ...state, panel: action.panel, mutationError: null }
    case 'DELETE_REQUESTED':
      return { ...state, deleteConfirmId: action.modelId, mutationError: null }
    case 'DELETE_DISMISSED':
      return { ...state, deleteConfirmId: null, mutationError: null }
    case 'MODEL_SELECTED':
      return { ...state, selectedModelId: action.modelId }
    case 'MUTATION_FAILED':
      return { ...state, mutationError: action.error }
    case 'MUTATION_STARTED':
      return { ...state, mutationError: null }
  }
}
