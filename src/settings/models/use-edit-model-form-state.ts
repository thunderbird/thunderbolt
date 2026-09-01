/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import type { ComboboxItem } from '@/components/ui/combobox'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import type { Model } from '@/types'
import { canFetchCatalog, type CatalogRequest } from './model-catalog'
import {
  apiKeyEditValue,
  hasModelConnectionChanges,
  modelApiKeyForConnection,
  providerRequiresConnectionTest,
  type ApiKeyEdit,
} from './model-policy'
import { catalogToComboboxItems, customModelItem, useAutoCatalogFetch, useModelCatalog } from './use-model-catalog'

const nameRequired = msg`Name is required.`
const modelNameRequired = msg`Model name is required.`
const urlRequiredForCustom = msg`URL is required for Custom providers`

const editModelFormSchema = (i18n: I18n) =>
  z.object({
    name: z.string().min(1, { message: i18n._(nameRequired) }),
    model: z.string().min(1, { message: i18n._(modelNameRequired) }),
    url: z.string().optional(),
    apiKey: z.string().optional(),
  })

const buildEditModelFormSchema = (i18n: I18n, provider: Model['provider']) =>
  editModelFormSchema(i18n).refine((data) => provider !== 'custom' || Boolean(data.url), {
    message: i18n._(urlRequiredForCustom),
    path: ['url'],
  })

type EditModelFormValues = z.infer<ReturnType<typeof editModelFormSchema>>

export type EditModelSubmission = Omit<EditModelFormValues, 'apiKey'> & {
  id: string
  apiKey: string | null | undefined
}

/** Owns edit-model form, catalog, API-key policy, and connection-test orchestration. */
export const useEditModelFormState = (model: Model) => {
  const { i18n } = useLingui()
  const form = useForm<EditModelFormValues>({
    resolver: zodResolver(buildEditModelFormSchema(i18n, model.provider)),
    defaultValues: { name: model.name || '', model: model.model, url: model.url || '', apiKey: '' },
  })
  const watchedModel = form.watch('model')
  const watchedUrl = form.watch('url')
  const watchedApiKey = form.watch('apiKey')
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [apiKeyEdit, setApiKeyEdit] = useState<ApiKeyEdit>({ kind: 'keep' })
  const catalog = useModelCatalog()
  const { fetchCatalog } = catalog
  // `apiKeyEdit` records the *kind* of edit, but a replacement token keeps
  // changing in the form field after the kind was set — substitute the live
  // watched value so probes and catalog refreshes use the latest keystroke.
  const liveApiKeyEdit: ApiKeyEdit =
    apiKeyEdit.kind === 'replace' ? { kind: 'replace', value: watchedApiKey ?? '' } : apiKeyEdit
  const effectiveApiKey = modelApiKeyForConnection(model.apiKey, liveApiKeyEdit)
  const catalogRequest = useMemo<CatalogRequest>(
    () => ({ provider: model.provider, apiKey: effectiveApiKey, url: watchedUrl }),
    [effectiveApiKey, model.provider, watchedUrl],
  )
  // The stored key must never leave the device without an explicit user
  // action, so the auto-fetch only arms for a freshly typed replacement key,
  // or for URL edits when no stored secret could ride along. Stored-key
  // catalogs load on demand when the model dropdown is opened (loadCatalog).
  const isAutoFetchArmed = apiKeyEdit.kind === 'replace' || (!model.apiKey && watchedUrl !== (model.url ?? ''))

  useAutoCatalogFetch({ armed: isAutoFetchArmed, request: catalogRequest, catalog })
  // Not memoized: `i18n` is a stable singleton, so a memo keyed on it would
  // never invalidate and the localized "Custom" entry would keep the outgoing
  // locale after a language switch. See the Localization section in AGENTS.md.
  const buildModelItems = (): ComboboxItem[] => {
    const items = catalogToComboboxItems(catalog.models)
    if (!catalog.models.some((available) => available.id === model.model)) {
      items.unshift({ id: model.model, label: model.model })
    }
    return [...items, customModelItem(i18n)]
  }
  const modelItems = buildModelItems()
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

  // Opening the model dropdown is the explicit user action that authorizes
  // fetching the provider catalog with the saved connection (including a
  // stored API key) — opening the edit panel alone must not send anything.
  const loadCatalog = () => {
    if (catalog.isLoading || catalog.models.length > 0 || !canFetchCatalog(catalogRequest)) {
      return
    }
    void fetchCatalog(catalogRequest)
  }

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
    loadCatalog,
    selectModel,
    changeUrl,
    changeApiKey,
    toggleClearApiKey,
    testConnection,
    submissionFor,
  }
}
