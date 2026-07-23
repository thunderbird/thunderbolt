/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import type { ComboboxItem } from '@/components/ui/combobox'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import type { Model } from '@/types'
import {
  apiKeyEditValue,
  hasModelConnectionChanges,
  modelApiKeyForConnection,
  providerRequiresConnectionTest,
  type ApiKeyEdit,
} from './model-policy'
import { catalogToComboboxItems, useModelCatalog } from './use-model-catalog'

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

type EditModelFormValues = z.infer<typeof editModelFormSchema>

export type EditModelSubmission = Omit<EditModelFormValues, 'apiKey'> & {
  id: string
  apiKey: string | null | undefined
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
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [apiKeyEdit, setApiKeyEdit] = useState<ApiKeyEdit>({ kind: 'keep' })
  const catalog = useModelCatalog()
  const effectiveApiKey = modelApiKeyForConnection(
    model.apiKey,
    apiKeyEdit.kind === 'replace' ? { kind: 'replace', value: watchedApiKey ?? '' } : apiKeyEdit,
  )
  const modelItems = useMemo((): ComboboxItem[] => {
    const items = catalogToComboboxItems(catalog.models)
    if (!catalog.models.some((available) => available.id === model.model)) {
      items.unshift({ id: model.model, label: model.model })
    }
    return [...items, { id: 'custom', label: 'Custom' }]
  }, [model.model, catalog.models])
  const connection = useModelConnectionTest({
    provider: model.provider,
    model: watchedModel,
    url: watchedUrl,
    apiKey: effectiveApiKey,
  })
  const hasConnectionEdits = hasModelConnectionChanges(model, {
    model: watchedModel,
    url: watchedUrl,
    apiKeyEdit,
  })
  const needsSuccessfulTest =
    hasConnectionEdits && apiKeyEdit.kind !== 'clear' && providerRequiresConnectionTest(model.provider)

  const selectModel = (id: string) => {
    if (id === 'custom') {
      setIsCustomModel(true)
      return
    }
    setIsCustomModel(false)
    form.setValue('model', id, { shouldValidate: true, shouldDirty: true })
  }
  const changeUrl = (value: string) => {
    form.setValue('url', value, { shouldValidate: true, shouldDirty: true })
    catalog.invalidateCatalog()
  }
  const changeApiKey = (value: string) => {
    form.setValue('apiKey', value, { shouldDirty: true })
    setApiKeyEdit(value ? { kind: 'replace', value } : { kind: 'keep' })
    catalog.invalidateCatalog()
  }
  const toggleClearApiKey = () => {
    form.setValue('apiKey', '', { shouldDirty: true })
    setApiKeyEdit(apiKeyEdit.kind === 'clear' ? { kind: 'keep' } : { kind: 'clear' })
    catalog.invalidateCatalog()
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
    apiKey: apiKeyEditValue(apiKeyEdit),
    id: model.id,
  })

  return {
    form,
    watchedModel,
    modelItems,
    isCustomModel,
    apiKeyEdit,
    isLoadingCatalog: catalog.isLoading,
    catalogError: catalog.error,
    effectiveApiKey,
    connection,
    isSaveDisabled:
      (!form.formState.isDirty && apiKeyEdit.kind === 'keep') ||
      (needsSuccessfulTest && connection.status !== 'success'),
    refreshCatalog: () =>
      void catalog.fetchCatalog({ provider: model.provider, apiKey: effectiveApiKey, url: watchedUrl }),
    selectModel,
    changeUrl,
    changeApiKey,
    toggleClearApiKey,
    testConnection,
    submissionFor,
  }
}
