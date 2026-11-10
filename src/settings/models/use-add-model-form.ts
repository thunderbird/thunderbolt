/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModelInTransaction } from '@/dal/models'
import { revokeReplacedTinfoilAuthorization, withTinfoilSessionLock } from '@/lib/tinfoil-session'
import { assertProviderConnectionAttemptCurrent, type ProviderAuthorization } from '@/lib/provider-connection-attempt'
import { getProviderConnectionRevision, saveProviderConnectionInTransaction } from '@/dal/provider-connections'
import { getProviderDefinition } from '@/providers/registry'
import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useReducer } from 'react'
import { useForm } from 'react-hook-form'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

import { useChatStore } from '@/chats/chat-store'
import type { ComboboxItem } from '@/components/ui/combobox'
import { useDatabase } from '@/contexts'
import { getAllModels, getAvailableModels, updateSettings } from '@/dal'
import { useLocalProviders } from '@/hooks/use-local-providers'
import { useAsyncAttempt } from '@/hooks/use-async-attempt'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import type { Model } from '@/types'
import type { CatalogRequest } from './model-catalog'
import { catalogToComboboxItems, customModelItem, useAutoCatalogFetch, useModelCatalog } from './use-model-catalog'
import { providerRequiresUrl } from './model-policy'
import { getModelDisplayName } from './model-display-name'

const nameRequired = msg`Name is required.`
const modelNameRequired = msg`Model name is required.`
const urlRequiredForProvider = msg`URL is required for this provider`
const apiKeyRequired = msg`API Key is required for this provider`

/** Built per render so the validation copy follows the active catalog — see the
 *  "Localization" section in AGENTS.md. */
export const createAddModelFormSchema = (i18n: I18n) =>
  z
    .object({
      provider: z.enum(['thunderbolt', 'anthropic', 'openai', 'custom', 'openrouter', 'tinfoil', 'otari']),
      name: z.string().min(1, { message: i18n._(nameRequired) }),
      model: z.string().min(1, { message: i18n._(modelNameRequired) }),
      customModel: z.string().optional(),
      url: z.string().optional(),
      apiKey: z.string().optional(),
      supportsTools: z.boolean(),
    })
    .refine((data) => !providerRequiresUrl(data.provider) || Boolean(data.url?.trim()), {
      message: i18n._(urlRequiredForProvider),
      path: ['url'],
    })
    .refine(
      (data) =>
        data.provider === 'thunderbolt' ||
        data.provider === 'custom' ||
        (data.apiKey !== undefined && data.apiKey.length > 0),
      { message: i18n._(apiKeyRequired), path: ['apiKey'] },
    )

export type AddModelFormValues = z.infer<ReturnType<typeof createAddModelFormSchema>>

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

type UseAddModelFormOptions = {
  isOpen: boolean
  onClose: () => void
  /** Called only after a model is saved and the available-model list is refreshed. */
  onSaved?: () => void
  /** Clears page-level mutation feedback when an add attempt begins. */
  onMutationStart?: () => void
}

/** Owns the reusable add-model form, catalog, connection test, and mutation. */
export const useAddModelForm = ({ isOpen, onClose, onSaved, onMutationStart }: UseAddModelFormOptions) => {
  const { i18n } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const isStandalone = useLocalProviders()
  const [state, dispatch] = useReducer(addModelReducer, initialState)
  const { selectedModelId, submitError } = state
  const catalog = useModelCatalog()
  const submission = useAsyncAttempt()
  const form = useForm<AddModelFormValues>({
    resolver: zodResolver(createAddModelFormSchema(i18n)),
    mode: 'onChange',
    defaultValues: {
      provider: isStandalone ? 'custom' : 'thunderbolt',
      name: '',
      model: '',
      customModel: '',
      url: '',
      apiKey: '',
      supportsTools: true,
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
    submission.cancel()
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
    mutationFn: async (
      values: AddModelFormValues &
        Partial<
          Pick<
            Model,
            | 'contextWindow'
            | 'vendor'
            | 'isConfidential'
            | 'supportsParallelToolCalls'
            | 'startWithReasoning'
            | 'oauthProvider'
            | 'providerDefault'
          >
        > & { providerAuthorization?: ProviderAuthorization; signal?: AbortSignal },
    ) => {
      const { providerAuthorization, signal, supportsTools = true, ...modelValues } = values
      const save = (attempt = providerAuthorization?.attempt, expectedRevision?: string | null) =>
        db.transaction(async (tx) => {
          // Authorization can be cancelled while this save waits for the session lock or database.
          signal?.throwIfAborted()
          const providerConnectionId =
            values.provider === 'thunderbolt'
              ? null
              : await saveProviderConnectionInTransaction(tx, {
                  provider: values.provider,
                  name: getProviderDefinition(values.provider).name,
                  url: values.url,
                  authMethod: providerAuthorization ? 'oauth' : 'api_key',
                  credentials:
                    providerAuthorization?.tinfoilCredentials ??
                    (providerAuthorization ? { access_token: values.apiKey } : { apiKey: values.apiKey ?? '' }),
                  attempt,
                  expectedRevision,
                })
          const previous = providerConnectionId
            ? (await getAllModels(tx)).find(
                (model) => model.providerConnectionId === providerConnectionId && model.model === values.model,
              )
            : undefined
          const id = previous?.id ?? uuidv7()
          if (!previous) {
            const { apiKey, oauthProvider, providerDefault, url, ...fields } = modelValues
            await createModelInTransaction(tx, {
              ...fields,
              id,
              providerConnectionId,
              url: null,
              isSystem: 0,
              enabled: 1,
              toolUsage: supportsTools ? 1 : 0,
              contextWindow: values.contextWindow ?? null,
            })
          }
          signal?.throwIfAborted()
          return { id, created: !previous }
        })
      const { id, created } =
        providerAuthorization?.attempt.provider === 'tinfoil'
          ? await withTinfoilSessionLock(async () => {
              await assertProviderConnectionAttemptCurrent(db, providerAuthorization.attempt)
              const revision = await getProviderConnectionRevision(db, 'oauth:tinfoil')
              const retired = providerAuthorization.tinfoilCredentials
                ? await revokeReplacedTinfoilAuthorization(db, providerAuthorization.tinfoilCredentials, signal)
                : undefined
              return save(retired ?? providerAuthorization.attempt, revision)
            })
          : await save()
      if (isStandalone && created) {
        await updateSettings(db, { selected_model: id })
      }
      return { id, models: await getAvailableModels(db) }
    },
    onMutate: () => {
      const attempt = submission.begin()
      if (!attempt) {
        throw new Error('A model save is already in progress')
      }
      onMutationStart?.()
      dispatch({ type: 'MUTATION_STARTED' })
      return attempt
    },
    onSuccess: async ({ models }, values, attempt) => {
      if (values.signal?.aborted) {
        return
      }
      useChatStore.getState().setModels(models)
      await queryClient.invalidateQueries({ queryKey: ['models'] })
      await queryClient.invalidateQueries({ queryKey: ['provider-connections'] })
      if (isStandalone) {
        await queryClient.invalidateQueries({ queryKey: ['settings'] })
      }
      if (values.signal?.aborted || !attempt?.isCurrent()) {
        return
      }
      close()
      onSaved?.()
    },
    onError: (_error, values, attempt) => {
      if (values.signal?.aborted || !attempt?.isCurrent()) {
        return
      }
      // Database errors can include bound API keys and OAuth tokens.
      console.error('Failed to add the model.')
      dispatch({ type: 'MUTATION_FAILED' })
    },
    onSettled: (_result, _error, _values, attempt) => attempt?.finish(),
  })

  const resolveModelId = (values: AddModelFormValues) =>
    selectedModelId === 'custom' && values.customModel ? values.customModel : values.model

  const submit = async (values: AddModelFormValues) => {
    try {
      await addMutation.mutateAsync({ ...values, model: resolveModelId(values) })
    } catch {
      // Mutation callbacks publish errors only while this form attempt is current.
    }
  }

  const testConnection = async () => {
    const values = form.getValues()
    const toolSupport = await connection.test({
      provider: values.provider,
      model: resolveModelId(values),
      url: values.url,
      apiKey: values.apiKey,
    })
    if (toolSupport) {
      form.setValue('supportsTools', toolSupport === 'supported')
    }
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
    form.setValue('name', getModelDisplayName(selected ?? { id: modelId }), { shouldValidate: true })
    // Thunderbolt models skip the connection test; the shipped defaults already know.
    if (provider === 'thunderbolt') {
      form.setValue('supportsTools', selected?.supports_tools !== false)
    }
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
    // The URL starts blank so the catalog auto-fetch never calls an endpoint the user did not enter.
    for (const field of ['name', 'model', 'customModel', 'apiKey', 'url'] as const) {
      form.setValue(field, '', { shouldValidate: false, shouldDirty: false })
    }
    form.setValue('supportsTools', true, { shouldDirty: false })
    void revalidateSilently()
  }

  // Not memoized: `i18n` is a stable singleton, so a memo keyed on it would
  // never invalidate and the localized "Custom" entry would keep the outgoing
  // locale after a language switch. See the Localization section in AGENTS.md.
  const buildModelItems = (): ComboboxItem[] => {
    const items = catalogToComboboxItems(catalog.models)
    return provider === 'thunderbolt' ? items : [...items, customModelItem(i18n)]
  }
  const modelItems = buildModelItems()

  return {
    allowServerModels: !isStandalone,
    form,
    modelItems,
    selectedModelId,
    isLoadingCatalog: catalog.isLoading,
    catalogError: catalog.error,
    isPending: addMutation.isPending,
    isTesting: connection.isTesting,
    connectionStatus: connection.status,
    connectionError: connection.error,
    toolSupport: connection.toolSupport,
    submitError,
    onSubmit: submit,
    saveModel: addMutation.mutateAsync,
    onCancel: close,
    onProviderChange: changeProvider,
    onCatalogInvalidated: catalog.invalidateCatalog,
    onSelectModel: selectModel,
    onTestConnection: testConnection,
    /** Discards every form-owned resource without changing the parent panel. */
    resetForm: reset,
    /** Clears leftover probe/error state when the add panel opens. */
    prepareForOpen: () => {
      submission.cancel()
      connection.reset()
      dispatch({ type: 'PANEL_OPENED' })
    },
  }
}
