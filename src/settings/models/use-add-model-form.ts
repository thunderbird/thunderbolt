/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useReducer } from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

import { useChatStore } from '@/chats/chat-store'
import type { ComboboxItem } from '@/components/ui/combobox'
import { useDatabase } from '@/contexts'
import { createModel, getAvailableModels } from '@/dal'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import type { Model } from '@/types'
import type { CatalogRequest } from './model-catalog'
import { catalogToComboboxItems, customModelItem, useAutoCatalogFetch, useModelCatalog } from './use-model-catalog'

export const addModelFormSchema = z
  .object({
    provider: z.enum(['thunderbolt', 'anthropic', 'openai', 'custom', 'openrouter', 'tinfoil']),
    name: z.string().min(1, { message: 'Name is required.' }),
    model: z.string().min(1, { message: 'Model name is required.' }),
    customModel: z.string().optional(),
    url: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .refine((data) => data.provider !== 'custom' || Boolean(data.url), {
    message: 'URL is required for Custom providers',
    path: ['url'],
  })
  .refine(
    (data) =>
      data.provider === 'thunderbolt' ||
      data.provider === 'custom' ||
      (data.apiKey !== undefined && data.apiKey.length > 0),
    { message: 'API Key is required for this provider', path: ['apiKey'] },
  )

export type AddModelFormValues = z.infer<typeof addModelFormSchema>

type AddModelState = {
  selectedModelId: string
  submitError: string | null
}

type AddModelAction =
  | { type: 'MODEL_SELECTED'; modelId: string }
  | { type: 'PANEL_OPENED' }
  | { type: 'MUTATION_STARTED' }
  | { type: 'MUTATION_FAILED' }
  | { type: 'FORM_DISCARDED' }

const initialState: AddModelState = {
  selectedModelId: '',
  submitError: null,
}

/** Reduces model selection and submission state owned only by the add form. */
const addModelReducer = (state: AddModelState, action: AddModelAction): AddModelState => {
  switch (action.type) {
    case 'MODEL_SELECTED':
      return { ...state, selectedModelId: action.modelId }
    case 'PANEL_OPENED':
    case 'MUTATION_STARTED':
      return { ...state, submitError: null }
    case 'MUTATION_FAILED':
      return { ...state, submitError: "Couldn't add the model. Please try again." }
    case 'FORM_DISCARDED':
      return initialState
  }
}

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

type UseAddModelFormOptions = {
  isOpen: boolean
  onClose: () => void
  /** Clears page-level mutation feedback when an add attempt begins. */
  onMutationStart?: () => void
}

/** Owns the reusable add-model form, catalog, connection test, and mutation. */
export const useAddModelForm = ({ isOpen, onClose, onMutationStart }: UseAddModelFormOptions) => {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(addModelReducer, initialState)
  const { selectedModelId, submitError } = state
  const catalog = useModelCatalog()
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
  const catalogRequest = useMemo<CatalogRequest>(() => ({ provider, apiKey, url }), [apiKey, provider, url])
  const connection = useModelConnectionTest({ provider, model, url, apiKey })

  useAutoCatalogFetch({ armed: isOpen, request: catalogRequest, catalog })

  const reset = () => {
    form.reset()
    form.clearErrors()
    connection.reset()
    catalog.invalidateCatalog()
    dispatch({ type: 'FORM_DISCARDED' })
  }

  const close = () => {
    reset()
    onClose()
  }

  const addMutation = useMutation({
    mutationFn: async (values: AddModelFormValues) => {
      await createModel(db, {
        id: uuidv7(),
        ...values,
        apiKey: values.apiKey || null,
        url: values.url || null,
        isSystem: 0,
        enabled: 1,
        toolUsage: 1,
        contextWindow: null,
      })
      return getAvailableModels(db)
    },
    onMutate: () => {
      onMutationStart?.()
      dispatch({ type: 'MUTATION_STARTED' })
    },
    onSuccess: async (models) => {
      useChatStore.getState().setModels(models)
      await queryClient.invalidateQueries({ queryKey: ['models'] })
      close()
    },
    onError: (error: unknown) => {
      console.error('Failed to add the model.', error)
      dispatch({ type: 'MUTATION_FAILED' })
    },
  })

  const resolveModelId = (values: AddModelFormValues) =>
    selectedModelId === 'custom' && values.customModel ? values.customModel : values.model

  const submit = (values: AddModelFormValues) => {
    addMutation.mutate({ ...values, model: resolveModelId(values) })
  }

  const testConnection = () => {
    const values = form.getValues()
    connection.test({
      provider: values.provider,
      model: resolveModelId(values),
      url: values.url,
      apiKey: values.apiKey,
    })
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

  // Recomputes formState.isValid for the freshly blanked fields (the submit
  // button keys off it) without painting error messages on a pristine form.
  const revalidateSilently = async () => {
    await form.trigger()
    form.clearErrors()
  }

  const changeProvider = (nextProvider: Model['provider']) => {
    catalog.invalidateCatalog()
    form.setValue('provider', nextProvider, { shouldValidate: false, shouldDirty: true })
    dispatch({ type: 'MODEL_SELECTED', modelId: '' })
    for (const field of ['name', 'model', 'customModel', 'apiKey'] as const) {
      form.setValue(field, '', { shouldValidate: false, shouldDirty: false })
    }
    // Ollama's default local endpoint — the most common custom provider.
    form.setValue('url', nextProvider === 'custom' ? 'http://localhost:11434/v1' : '', {
      shouldValidate: false,
      shouldDirty: false,
    })
    void revalidateSilently()
  }

  const modelItems = useMemo((): ComboboxItem[] => {
    const items = catalogToComboboxItems(catalog.models)
    return provider === 'thunderbolt' ? items : [...items, customModelItem]
  }, [catalog.models, provider])
  const supportsTools =
    !selectedModelId ||
    selectedModelId === 'custom' ||
    catalog.models.find((candidate) => candidate.id === selectedModelId)?.supports_tools === true

  return {
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
    submitError,
    onSubmit: submit,
    onCancel: close,
    onProviderChange: changeProvider,
    onCatalogInvalidated: catalog.invalidateCatalog,
    onSelectModel: selectModel,
    onTestConnection: testConnection,
    /** Discards every form-owned resource without changing the parent panel. */
    resetForm: reset,
    /** Clears leftover probe/error state when the add panel opens. */
    prepareForOpen: () => {
      connection.reset()
      dispatch({ type: 'PANEL_OPENED' })
    },
  }
}
