/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useReducer } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import type { ComboboxItem } from '@/components/ui/combobox'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import type { Model } from '@/types'
import {
  catalogRequestKey,
  describeModelFetchError,
  fetchModelsForProvider,
  type AvailableModel,
} from './model-catalog'
import {
  apiKeyEditValue,
  hasModelConnectionChanges,
  modelApiKeyForConnection,
  providerRequiresConnectionTest,
  type ApiKeyEdit,
} from './model-policy'

const editModelFormSchema = z.object({
  name: z.string().min(1, { message: 'Name is required.' }),
  model: z.string().min(1, { message: 'Model name is required.' }),
  url: z.string().optional(),
  apiKey: z.string().optional(),
})

const buildEditModelFormSchema = (provider: Model['provider']) =>
  editModelFormSchema.refine((data) => provider !== 'custom' || Boolean(data.url), {
    message: 'URL is required for Custom providers',
    path: ['url'],
  })

export type EditModelFormValues = z.infer<typeof editModelFormSchema>

export type EditModelSubmission = Omit<EditModelFormValues, 'apiKey'> & {
  id: string
  apiKey: string | null | undefined
}

export type EditModelFormState = {
  availableModels: AvailableModel[]
  catalogRequestKey: string | null
  isCustomModel: boolean
  apiKeyEdit: ApiKeyEdit
  isLoadingCatalog: boolean
  catalogError: string | null
}

export type EditModelFormAction =
  | { type: 'catalog-loading'; requestKey: string }
  | { type: 'catalog-loaded'; requestKey: string; models: AvailableModel[] }
  | { type: 'catalog-failed'; requestKey: string; error: string }
  | { type: 'catalog-invalidated' }
  | { type: 'custom-model'; enabled: boolean }
  | { type: 'api-key-edit'; edit: ApiKeyEdit }

export const initialEditModelFormState: EditModelFormState = {
  availableModels: [],
  catalogRequestKey: null,
  isCustomModel: false,
  apiKeyEdit: { kind: 'keep' },
  isLoadingCatalog: false,
  catalogError: null,
}

export const editModelFormReducer = (state: EditModelFormState, action: EditModelFormAction): EditModelFormState => {
  switch (action.type) {
    case 'catalog-loading':
      return {
        ...state,
        catalogRequestKey: action.requestKey,
        isLoadingCatalog: true,
        catalogError: null,
        availableModels: [],
      }
    case 'catalog-loaded':
      return state.catalogRequestKey === action.requestKey
        ? { ...state, isLoadingCatalog: false, availableModels: action.models }
        : state
    case 'catalog-failed':
      return state.catalogRequestKey === action.requestKey
        ? { ...state, isLoadingCatalog: false, availableModels: [], catalogError: action.error }
        : state
    case 'catalog-invalidated':
      return {
        ...state,
        catalogRequestKey: null,
        isLoadingCatalog: false,
        availableModels: [],
        catalogError: null,
      }
    case 'custom-model':
      return { ...state, isCustomModel: action.enabled }
    case 'api-key-edit':
      return { ...state, apiKeyEdit: action.edit }
  }
}

/** Owns edit-model form, catalog, API-key policy, and connection-test orchestration. */
export const useEditModelFormState = (model: Model) => {
  const form = useForm<EditModelFormValues>({
    resolver: zodResolver(buildEditModelFormSchema(model.provider)),
    defaultValues: { name: model.name || '', model: model.model, url: model.url || '', apiKey: '' },
  })
  const watchedModel = form.watch('model')
  const watchedUrl = form.watch('url')
  const watchedApiKey = form.watch('apiKey')
  const [state, dispatch] = useReducer(editModelFormReducer, initialEditModelFormState)
  const effectiveApiKey = modelApiKeyForConnection(
    model.apiKey,
    state.apiKeyEdit.kind === 'replace' ? { kind: 'replace', value: watchedApiKey ?? '' } : state.apiKeyEdit,
  )
  const modelItems = useMemo((): ComboboxItem[] => {
    const items: ComboboxItem[] = state.availableModels.map((available) => ({
      id: available.id,
      label: available.name || available.id,
      description: available.name ? available.id : undefined,
    }))
    if (!state.availableModels.some((available) => available.id === model.model)) {
      items.unshift({ id: model.model, label: model.model })
    }
    return [...items, { id: 'custom', label: 'Custom' }]
  }, [model.model, state.availableModels])
  const connection = useModelConnectionTest({
    provider: model.provider,
    model: watchedModel,
    url: watchedUrl,
    apiKey: effectiveApiKey,
  })
  const hasConnectionEdits = hasModelConnectionChanges(model, {
    model: watchedModel,
    url: watchedUrl,
    apiKeyEdit: state.apiKeyEdit,
  })
  const needsSuccessfulTest =
    hasConnectionEdits && state.apiKeyEdit.kind !== 'clear' && providerRequiresConnectionTest(model.provider)

  const invalidateCatalog = () => dispatch({ type: 'catalog-invalidated' })
  const refreshCatalog = async () => {
    const requestKey = catalogRequestKey({ provider: model.provider, apiKey: effectiveApiKey, url: watchedUrl })
    dispatch({ type: 'catalog-loading', requestKey })
    try {
      dispatch({
        type: 'catalog-loaded',
        requestKey,
        models: await fetchModelsForProvider({ provider: model.provider, apiKey: effectiveApiKey, url: watchedUrl }),
      })
    } catch (error) {
      dispatch({ type: 'catalog-failed', requestKey, error: describeModelFetchError(error) })
    }
  }
  const selectModel = (id: string) => {
    if (id === 'custom') {
      dispatch({ type: 'custom-model', enabled: true })
      return
    }
    dispatch({ type: 'custom-model', enabled: false })
    form.setValue('model', id, { shouldValidate: true, shouldDirty: true })
  }
  const changeUrl = (value: string) => {
    form.setValue('url', value, { shouldValidate: true, shouldDirty: true })
    invalidateCatalog()
  }
  const changeApiKey = (value: string) => {
    form.setValue('apiKey', value, { shouldDirty: true })
    dispatch({ type: 'api-key-edit', edit: value ? { kind: 'replace', value } : { kind: 'keep' } })
    invalidateCatalog()
  }
  const toggleClearApiKey = () => {
    form.setValue('apiKey', '', { shouldDirty: true })
    dispatch({
      type: 'api-key-edit',
      edit: state.apiKeyEdit.kind === 'clear' ? { kind: 'keep' } : { kind: 'clear' },
    })
    invalidateCatalog()
  }
  const testConnection = () => {
    const values = form.getValues()
    connection.test({
      provider: model.provider,
      model: values.model,
      url: values.url,
      apiKey: effectiveApiKey,
    })
  }
  const submissionFor = (values: EditModelFormValues): EditModelSubmission => ({
    ...values,
    apiKey: apiKeyEditValue(state.apiKeyEdit),
    id: model.id,
  })

  return {
    form,
    watchedModel,
    modelItems,
    isCustomModel: state.isCustomModel,
    apiKeyEdit: state.apiKeyEdit,
    isLoadingCatalog: state.isLoadingCatalog,
    catalogError: state.catalogError,
    effectiveApiKey,
    connection,
    isSaveDisabled:
      (!form.formState.isDirty && state.apiKeyEdit.kind === 'keep') ||
      (needsSuccessfulTest && connection.status !== 'success'),
    refreshCatalog,
    selectModel,
    changeUrl,
    changeApiKey,
    toggleClearApiKey,
    testConnection,
    submissionFor,
  }
}
