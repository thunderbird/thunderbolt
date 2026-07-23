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
import { catalogRequestKey, describeModelFetchError, fetchModelsForProvider } from './model-catalog'
import type { EditModelSubmission } from './edit-model-form'
import { initialModelsPageState, modelsPageReducer } from './page-state'

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
  const { panel, deleteConfirmId, loadingCatalog, selectedModelId, catalog, catalogError } = state
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

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateModel(db, id, { enabled: enabled ? 1 : 0 }),
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
    onSuccess: () => {
      form.reset()
      form.clearErrors()
      dispatch({ type: 'open-panel', panel: null })
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteModel(db, id),
    onSuccess: () => dispatch({ type: 'confirm-delete', modelId: null }),
  })
  const editMutation = useMutation({
    mutationFn: async (values: EditModelSubmission) => {
      const { id, ...fields } = values
      await updateModel(db, id, { ...fields, url: fields.url || null })
    },
    onSuccess: (_result, values) => dispatch({ type: 'open-panel', panel: { kind: 'detail', modelId: values.id } }),
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
  })

  const fetchCatalog = async (nextProvider: Model['provider'], nextApiKey?: string, nextUrl?: string) => {
    const requestKey = catalogRequestKey({ provider: nextProvider, apiKey: nextApiKey, url: nextUrl })
    dispatch({ type: 'catalog-loading', requestKey })
    try {
      dispatch({
        type: 'catalog-loaded',
        requestKey,
        models: await fetchModelsForProvider({ provider: nextProvider, apiKey: nextApiKey, url: nextUrl }),
      })
    } catch (error) {
      console.error('Failed to fetch models:', error)
      dispatch({ type: 'catalog-failed', requestKey, error: describeModelFetchError(error) })
    }
  }
  const setAddPanelOpen = (open: boolean) => {
    if (open) {
      dispatch({ type: 'open-panel', panel: { kind: 'add' } })
      connection.reset()
      if (form.getValues('provider') === 'thunderbolt' && catalog.length === 0) {
        void fetchCatalog('thunderbolt')
      }
      return
    }
    form.reset()
    form.clearErrors()
    dispatch({ type: 'open-panel', panel: null })
    connection.reset()
  }
  const closePanel = () => {
    if (isAddPanelOpen) {
      form.reset()
      form.clearErrors()
      connection.reset()
    }
    dispatch({
      type: 'open-panel',
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
    dispatch({ type: 'select-model', modelId })
    if (modelId === 'custom') {
      form.setValue('model', '', { shouldValidate: true })
      form.setValue('customModel', '')
      form.setValue('name', '', { shouldValidate: true })
      return
    }
    form.setValue('model', modelId, { shouldValidate: true })
    form.setValue('customModel', '')
    const selected = catalog.find((candidate) => candidate.id === modelId)
    form.setValue('name', selected?.name || generateModelName(modelId), { shouldValidate: true })
  }
  const changeProvider = (nextProvider: Model['provider']) => {
    dispatch({ type: 'invalidate-catalog' })
    form.setValue('name', '', { shouldValidate: false, shouldDirty: false })
    form.setValue('model', '', { shouldValidate: false, shouldDirty: false })
    form.setValue('customModel', '', { shouldValidate: false, shouldDirty: false })
    form.setValue('url', nextProvider === 'custom' ? 'http://localhost:11434/v1' : '', {
      shouldValidate: false,
      shouldDirty: false,
    })
    form.setValue('apiKey', '', { shouldValidate: false, shouldDirty: false })
    void form.trigger()
    if (nextProvider === 'thunderbolt' || nextProvider === 'anthropic') {
      void fetchCatalog(nextProvider)
    }
  }
  const modelItems = useMemo((): ComboboxItem[] => {
    const items = catalog.map((candidate) => ({
      id: candidate.id,
      label: candidate.name || candidate.id,
      description: candidate.name ? candidate.id : undefined,
    }))
    return provider === 'thunderbolt' ? items : [...items, { id: 'custom', label: 'Custom' }]
  }, [catalog, provider])
  const supportsTools =
    !selectedModelId ||
    selectedModelId === 'custom' ||
    catalog.find((candidate) => candidate.id === selectedModelId)?.supports_tools === true

  return {
    isMobile,
    panel,
    deleteConfirmId,
    models,
    activeModelId,
    activeModel,
    editingModel,
    isAddPanelOpen,
    addForm: {
      form,
      modelItems,
      selectedModelId,
      isLoadingCatalog: loadingCatalog,
      catalogError,
      supportsTools,
      isPending: addMutation.isPending,
      isTesting: connection.isTesting,
      connectionStatus: connection.status,
      connectionError: connection.error,
      onSubmit: submitAdd,
      onCancel: () => setAddPanelOpen(false),
      onProviderChange: changeProvider,
      onCatalogInvalidated: () => dispatch({ type: 'invalidate-catalog' }),
      onRefreshCatalog: () => void fetchCatalog(provider, apiKey, url),
      onSelectModel: selectModel,
      onTestConnection: testConnection,
    },
    openAddPanel: () => setAddPanelOpen(true),
    closePanel,
    selectActiveModel: (modelId: string) =>
      dispatch({
        type: 'open-panel',
        panel: activeModelId === modelId ? null : { kind: 'detail', modelId },
      }),
    toggleModel: (id: string, enabled: boolean) => toggleMutation.mutate({ id, enabled }),
    openEditPanel: (modelId: string) => dispatch({ type: 'open-panel', panel: { kind: 'edit', modelId } }),
    closeEditPanel: (modelId: string) => dispatch({ type: 'open-panel', panel: { kind: 'detail', modelId } }),
    submitEdit: (values: EditModelSubmission) => editMutation.mutate(values),
    isEditPending: editMutation.isPending,
    requestDelete: (modelId: string | null) => dispatch({ type: 'confirm-delete', modelId }),
    confirmDelete: () => {
      if (deleteConfirmId) {
        deleteMutation.mutate(deleteConfirmId)
      }
    },
    isDeletePending: deleteMutation.isPending,
    resetModel: (id: string) => resetMutation.mutate(id),
  }
}
