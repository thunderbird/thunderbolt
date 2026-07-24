/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useMemo, useReducer } from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'

import type { ComboboxItem } from '@/components/ui/combobox'
import { useDatabase } from '@/contexts'
import { createModel, deleteModel, getAllModels, resetModelToDefault, updateModel } from '@/dal'
import { useIsMobile } from '@/hooks/use-mobile'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import type { Model } from '@/types'
import { defaultModels } from '@shared/defaults/models'
import { addModelFormSchema, type AddModelFormValues } from './add-model-form'
import type { EditModelSubmission } from './edit-model-form'
import { providerAutoFetchesCatalog } from './model-policy'
import { initialModelsPageState, modelsPageReducer } from './page-state'
import { catalogToComboboxItems, useModelCatalog } from './use-model-catalog'

/** Generates a readable display name from a provider model identifier. */
export const generateModelName = (modelId: string): string => {
  const segment = modelId.split('/').pop() ?? modelId
  const beforeColon = segment.split(':')[0]
  const parts = beforeColon.split(/[-_]+/).flatMap((part) => {
    if (/^[A-Za-z]\d$/.test(part)) {
      return [part]
    }
    return part.match(/[A-Za-z]+|[0-9]+(?:\.[0-9]+)?/g) ?? []
  })
  return parts.map((part) => (/^[0-9]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))).join(' ')
}

/** Owns Models page reducer, forms, catalog requests, tests, and DAL mutations. */
export const useModelsPageState = () => {
  const db = useDatabase()
  const { isMobile } = useIsMobile()
  const [state, dispatch] = useReducer(modelsPageReducer, initialModelsPageState)
  const { panel, deleteConfirmId, selectedModelId, mutationError } = state
  const catalog = useModelCatalog()
  const isAddPanelOpen = panel?.kind === 'add'
  const activeModelId = panel?.kind === 'detail' || panel?.kind === 'edit' ? panel.modelId : null
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    query: toCompilableQuery(getAllModels(db)),
  })
  const activeModel = models.find((model) => model.id === activeModelId)
  const editingModel = panel?.kind === 'edit' ? activeModel : undefined
  const form = useForm<AddModelFormValues>({
    resolver: zodResolver(addModelFormSchema),
    mode: 'onChange',
    defaultValues: {
      provider: 'thunderbolt',
      name: '',
      model: '',
      customModel: '',
      url: '',
      apiKey: '',
    },
  })
  const provider = form.watch('provider')
  const apiKey = form.watch('apiKey')
  const url = form.watch('url')
  const model = form.watch('model')
  const connection = useModelConnectionTest({ provider, model, url, apiKey })

  const failMutation = (message: string) => (error: unknown) => {
    console.error(message, error)
    dispatch({ type: 'MUTATION_FAILED', error: message })
  }
  const clearMutationError = () => dispatch({ type: 'MUTATION_STARTED' })

  /** Tears down every piece of add-form state so a reopened panel starts fresh. */
  const resetAddForm = () => {
    form.reset()
    form.clearErrors()
    connection.reset()
    catalog.invalidateCatalog()
    dispatch({ type: 'MODEL_SELECTED', modelId: '' })
  }

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateModel(db, id, { enabled: enabled ? 1 : 0 }),
    onMutate: clearMutationError,
    onError: failMutation('Failed to update the model.'),
  })
  const addMutation = useMutation({
    mutationFn: (values: AddModelFormValues) =>
      createModel(db, {
        id: uuidv7(),
        ...values,
        apiKey: values.apiKey || null,
        url: values.url || null,
        isSystem: 0,
        enabled: 1,
        toolUsage: 1,
        contextWindow: null,
      }),
    onMutate: clearMutationError,
    onSuccess: () => {
      resetAddForm()
      dispatch({ type: 'PANEL_CHANGED', panel: null })
    },
    onError: failMutation('Failed to add the model.'),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteModel(db, id),
    onMutate: clearMutationError,
    onSuccess: () => dispatch({ type: 'DELETE_DISMISSED' }),
    onError: failMutation('Failed to remove the model.'),
  })
  const editMutation = useMutation({
    mutationFn: async (values: EditModelSubmission) => {
      const { id, ...fields } = values
      await updateModel(db, id, { ...fields, url: fields.url || null })
    },
    onMutate: clearMutationError,
    onSuccess: (_result, values) => dispatch({ type: 'PANEL_CHANGED', panel: { kind: 'detail', modelId: values.id } }),
    onError: failMutation('Failed to save the model.'),
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
    onError: failMutation('Failed to reset the model.'),
  })

  const setAddPanelOpen = (open: boolean) => {
    if (open) {
      dispatch({ type: 'PANEL_CHANGED', panel: { kind: 'add' } })
      connection.reset()
      const currentProvider = form.getValues('provider')
      if (providerAutoFetchesCatalog(currentProvider) && catalog.models.length === 0) {
        void catalog.fetchCatalog({ provider: currentProvider })
      }
      return
    }
    resetAddForm()
    dispatch({ type: 'PANEL_CHANGED', panel: null })
  }
  const closePanel = () => {
    if (isAddPanelOpen) {
      resetAddForm()
    }
    dispatch({
      type: 'PANEL_CHANGED',
      panel: panel?.kind === 'edit' ? { kind: 'detail', modelId: panel.modelId } : null,
    })
  }
  const submitAdd = (values: AddModelFormValues) => {
    const modelId = selectedModelId === 'custom' && values.customModel ? values.customModel : values.model
    addMutation.mutate({ ...values, model: modelId })
  }
  const testConnection = () => {
    const values = form.getValues()
    const modelId = selectedModelId === 'custom' && values.customModel ? values.customModel : values.model
    connection.test({ provider: values.provider, model: modelId, url: values.url, apiKey: values.apiKey })
  }
  const selectModel = (modelId: string) => {
    dispatch({ type: 'MODEL_SELECTED', modelId })
    if (modelId === 'custom') {
      form.setValue('model', '', { shouldValidate: true })
      form.setValue('customModel', '')
      form.setValue('name', '', { shouldValidate: true })
      return
    }
    form.setValue('model', modelId, { shouldValidate: true })
    form.setValue('customModel', '')
    const selected = catalog.models.find((candidate) => candidate.id === modelId)
    form.setValue('name', selected?.name || generateModelName(modelId), { shouldValidate: true })
  }
  const changeProvider = (nextProvider: Model['provider']) => {
    catalog.invalidateCatalog()
    // Clear the picked model too — a stale selection (especially 'custom') would
    // keep the previous provider's model/custom fields rendered against the new
    // provider's catalog.
    dispatch({ type: 'MODEL_SELECTED', modelId: '' })
    form.setValue('name', '', { shouldValidate: false, shouldDirty: false })
    form.setValue('model', '', { shouldValidate: false, shouldDirty: false })
    form.setValue('customModel', '', { shouldValidate: false, shouldDirty: false })
    form.setValue('url', nextProvider === 'custom' ? 'http://localhost:11434/v1' : '', {
      shouldValidate: false,
      shouldDirty: false,
    })
    form.setValue('apiKey', '', { shouldValidate: false, shouldDirty: false })
    void form.trigger()
    if (providerAutoFetchesCatalog(nextProvider)) {
      void catalog.fetchCatalog({ provider: nextProvider })
    }
  }
  const modelItems = useMemo((): ComboboxItem[] => {
    const items = catalogToComboboxItems(catalog.models)
    return provider === 'thunderbolt' ? items : [...items, { id: 'custom', label: 'Custom' }]
  }, [catalog.models, provider])
  const supportsTools =
    !selectedModelId ||
    selectedModelId === 'custom' ||
    catalog.models.find((candidate) => candidate.id === selectedModelId)?.supports_tools === true

  return {
    isMobile,
    panel,
    deleteConfirmId,
    models,
    activeModelId,
    activeModel,
    editingModel,
    isAddPanelOpen,
    mutationError,
    addForm: {
      form,
      modelItems,
      selectedModelId,
      isLoadingCatalog: catalog.isLoading,
      catalogError: catalog.error,
      supportsTools,
      isPending: addMutation.isPending,
      isTesting: connection.isTesting,
      connectionStatus: connection.status,
      connectionError: connection.error,
      submitError: mutationError,
      onSubmit: submitAdd,
      onCancel: () => setAddPanelOpen(false),
      onProviderChange: changeProvider,
      onCatalogInvalidated: catalog.invalidateCatalog,
      onRefreshCatalog: () => void catalog.fetchCatalog({ provider, apiKey, url }),
      onSelectModel: selectModel,
      onTestConnection: testConnection,
    },
    openAddPanel: () => setAddPanelOpen(true),
    closePanel,
    selectActiveModel: (modelId: string) =>
      dispatch({
        type: 'PANEL_CHANGED',
        panel: activeModelId === modelId ? null : { kind: 'detail', modelId },
      }),
    toggleModel: (id: string, enabled: boolean) => toggleMutation.mutate({ id, enabled }),
    openEditPanel: (modelId: string) => dispatch({ type: 'PANEL_CHANGED', panel: { kind: 'edit', modelId } }),
    closeEditPanel: (modelId: string) => dispatch({ type: 'PANEL_CHANGED', panel: { kind: 'detail', modelId } }),
    submitEdit: (values: EditModelSubmission) => editMutation.mutate(values),
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
