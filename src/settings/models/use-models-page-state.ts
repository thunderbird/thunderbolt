/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useProviderVisibility } from '@/providers/use-provider-visibility'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useMutation } from '@tanstack/react-query'
import { useCallback, useReducer } from 'react'
import { useLingui } from '@lingui/react/macro'

import { useAsyncAttempt } from '@/hooks/use-async-attempt'
import { useDatabase } from '@/contexts'
import { useLocalProviders } from '@/hooks/use-local-providers'
import { deleteModel, getAllModels, getAvailableModels, resetModelToDefault, updateModel } from '@/dal'
import { useChatStore } from '@/chats/chat-store'
import { defaultModels } from '@shared/defaults/models'
import type { EditModelSubmission } from './edit-model-form'
import { initialModelsPageState, modelsPageReducer, type ModelPanel, type ModelsPageAction } from './page-state'
import { modelRequiresServer } from './model-policy'

/** Owns saved-model selection and mutations; each aside owns its form state. */
export const useModelsPageState = () => {
  const { t } = useLingui()
  const db = useDatabase()
  const { isProviderVisible } = useProviderVisibility()
  const localProviders = useLocalProviders()
  const editing = useAsyncAttempt()
  const [state, dispatch] = useReducer(modelsPageReducer, initialModelsPageState)
  const { panel, deleteConfirmId, mutationError } = state
  const isAddPanelOpen = panel?.kind === 'add'
  const activeModelId = panel?.kind === 'detail' || panel?.kind === 'edit' ? panel.modelId : null
  const { data: allModels = [] } = useQuery({
    queryKey: ['models'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const models = allModels.filter(
    (model) => isProviderVisible(model.provider) && (!localProviders || !modelRequiresServer(model)),
  )
  const activeModel = models.find((model) => model.id === activeModelId)
  const editingModel = panel?.kind === 'edit' ? activeModel : undefined
  const clearMutationError = useCallback(() => dispatch({ type: 'MUTATION_STARTED' }), [])

  const reportFailure = (action: Extract<ModelsPageAction, { type: 'MUTATION_FAILED' }>) => {
    // Database errors can include the API key bound to an update statement.
    console.error(action.error)
    dispatch(action)
  }
  const failMutation = (message: string) => () => reportFailure({ type: 'MUTATION_FAILED', error: message })
  const refreshModels = async () => useChatStore.getState().setModels(await getAvailableModels(db))
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateModel(db, id, { enabled: enabled ? 1 : 0 }),
    onMutate: clearMutationError,
    onSuccess: refreshModels,
    onError: failMutation(t`Failed to update the model.`),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteModel(db, id),
    onMutate: clearMutationError,
    onSuccess: async (_result, modelId) => {
      await refreshModels()
      dispatch({ type: 'DELETE_COMPLETED', modelId })
    },
    onError: (_error, modelId) =>
      reportFailure({ type: 'MUTATION_FAILED', error: t`Failed to delete the model.`, expectedDeleteId: modelId }),
  })
  const editMutation = useMutation({
    mutationFn: async (values: EditModelSubmission) => {
      const { id, ...fields } = values
      await updateModel(db, id, fields)
    },
    onSuccess: refreshModels,
  })
  const resetMutation = useMutation({
    mutationFn: async (id: string) => {
      const defaultModel = defaultModels.find((candidate) => candidate.id === id)
      if (!defaultModel) {
        await deleteModel(db, id)
        return
      }
      await resetModelToDefault(db, id, defaultModel)
    },
    onMutate: clearMutationError,
    onSuccess: refreshModels,
    onError: failMutation(t`Failed to reset the model.`),
  })

  const openAddPanel = () => {
    editing.cancel()
    dispatch({ type: 'PANEL_CHANGED', panel: { kind: 'add' } })
  }
  const changePanel = (nextPanel: ModelPanel) => {
    editing.cancel()
    dispatch({ type: 'PANEL_CHANGED', panel: nextPanel })
  }
  const closePanel = () => {
    editing.cancel()
    dispatch({
      type: 'PANEL_CHANGED',
      panel: panel?.kind === 'edit' ? { kind: 'detail', modelId: panel.modelId } : null,
    })
  }

  const submitEdit = async (values: EditModelSubmission) => {
    const attempt = editing.begin()
    if (!attempt) {
      return
    }
    try {
      clearMutationError()
      await editMutation.mutateAsync(values)
      if (attempt.isCurrent()) {
        changePanel({ kind: 'detail', modelId: values.id })
      }
    } catch {
      if (attempt.isCurrent()) {
        failMutation(t`Failed to save the model.`)()
      }
    } finally {
      attempt.finish()
    }
  }

  return {
    panel,
    deleteConfirmId,
    models,
    activeModelId,
    activeModel,
    editingModel,
    isAddPanelOpen,
    mutationError,
    openAddPanel,
    closePanel,
    selectActiveModel: (modelId: string) => changePanel(activeModelId === modelId ? null : { kind: 'detail', modelId }),
    toggleModel: (id: string, enabled: boolean) => toggleMutation.mutate({ id, enabled }),
    openEditPanel: (modelId: string) => changePanel({ kind: 'edit', modelId }),
    closeEditPanel: (modelId: string) => changePanel({ kind: 'detail', modelId }),
    submitEdit,
    isEditPending: editMutation.isPending,
    requestDelete: (modelId: string | null) =>
      modelId ? dispatch({ type: 'DELETE_REQUESTED', modelId }) : dispatch({ type: 'DELETE_DISMISSED' }),
    confirmDelete: () => {
      if (deleteConfirmId) {
        deleteMutation.mutate(deleteConfirmId)
      }
    },
    isDeletePending: deleteMutation.isPending,
    resetModel: (id: string) => resetMutation.mutate(id),
  }
}
