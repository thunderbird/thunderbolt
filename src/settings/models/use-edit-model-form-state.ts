/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useDatabase } from '@/contexts'
import { useModelConnectionTest } from '@/hooks/use-model-connection-test'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import { fetchProviderModels } from '@/providers/models'
import type { Model } from '@/types'
import { canFetchCatalog } from './model-catalog'
import {
  apiKeyEditValue,
  hasModelConnectionChanges,
  modelApiKeyForConnection,
  providerRequiresConnectionTest,
  providerRequiresUrl,
  type ApiKeyEdit,
} from './model-policy'
import { catalogToComboboxItems, customModelItem, useModelCatalog } from './use-model-catalog'

const nameRequired = msg`Name is required.`
const modelNameRequired = msg`Model name is required.`
const urlRequired = msg`URL is required for Custom providers`

const editModelFormSchema = (i18n: I18n, model: Model) =>
  z
    .object({
      name: z
        .string()
        .trim()
        .min(1, { message: i18n._(nameRequired) }),
      model: z
        .string()
        .trim()
        .min(1, { message: i18n._(modelNameRequired) }),
      url: z.string().trim(),
      apiKey: z.string(),
      supportsTools: z.boolean(),
    })
    .refine(
      (values) => Boolean(model.providerConnectionId) || !providerRequiresUrl(model.provider) || Boolean(values.url),
      {
        message: i18n._(urlRequired),
        path: ['url'],
      },
    )
type EditModelFormValues = z.infer<ReturnType<typeof editModelFormSchema>>
export type EditModelSubmission = {
  id: string
  name: string
  model: string
  toolUsage: number
  url?: string
  apiKey?: string | null
}

/** Edits model preferences and retains credential repair for models without a reusable connection. */
export const useEditModelFormState = (model: Model) => {
  const { i18n, t } = useLingui()
  const db = useDatabase()
  const getProxyFetch = useProxyFetchGetter()
  const form = useForm<EditModelFormValues>({
    resolver: zodResolver(editModelFormSchema(i18n, model)),
    defaultValues: {
      name: model.name || '',
      model: model.model,
      url: model.url ?? '',
      apiKey: '',
      supportsTools: model.toolUsage !== 0,
    },
  })
  const watchedModel = form.watch('model')
  const watchedUrl = form.watch('url')
  const watchedApiKey = form.watch('apiKey')
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [apiKeyEdit, setApiKeyEdit] = useState<ApiKeyEdit>({ kind: 'keep' })
  const liveApiKeyEdit: ApiKeyEdit =
    apiKeyEdit.kind === 'replace' ? { kind: 'replace', value: watchedApiKey } : apiKeyEdit
  const effectiveApiKey = modelApiKeyForConnection(model.apiKey, liveApiKeyEdit)
  const legacyCatalog = useModelCatalog()
  const legacyCatalogRequest = { provider: model.provider, apiKey: effectiveApiKey, url: watchedUrl }
  const catalog = useQuery({
    queryKey: ['provider-models', 'edit', model.providerConnectionId],
    queryFn: () => fetchProviderModels(db, model.providerConnectionId!, getProxyFetch),
    enabled: false,
    retry: false,
  })
  const modelItems = catalogToComboboxItems(model.providerConnectionId ? (catalog.data ?? []) : legacyCatalog.models)
  if (!modelItems.some((item) => item.id === model.model)) {
    modelItems.unshift({ id: model.model, label: model.model })
  }
  modelItems.push(customModelItem(i18n))
  const config = {
    provider: model.provider,
    model: watchedModel,
    providerConnectionId: model.providerConnectionId,
    apiKey: model.providerConnectionId ? model.apiKey : effectiveApiKey,
    url: model.providerConnectionId ? model.url : watchedUrl,
    oauthProvider: liveApiKeyEdit.kind === 'keep' ? model.oauthProvider : null,
  }
  const connection = useModelConnectionTest(config)
  const hasConnectionEdits = hasModelConnectionChanges(model, {
    model: watchedModel,
    url: config.url,
    apiKeyEdit: liveApiKeyEdit,
  })
  const needsSuccessfulTest =
    hasConnectionEdits && apiKeyEdit.kind !== 'clear' && providerRequiresConnectionTest(model.provider)
  const selectModel = (id: string) => {
    setIsCustomModel(id === 'custom')
    if (id !== 'custom') {
      form.setValue('model', id, { shouldValidate: true, shouldDirty: true })
    }
  }
  const testConnection = async () => {
    const toolSupport = await connection.test(config)
    if (toolSupport) {
      form.setValue('supportsTools', toolSupport === 'supported', { shouldDirty: true })
    }
  }
  return {
    form,
    watchedModel,
    modelItems,
    isCustomModel,
    apiKeyEdit,
    effectiveApiKey,
    isLoadingCatalog: model.providerConnectionId ? catalog.isFetching : legacyCatalog.isLoading,
    catalogError: model.providerConnectionId
      ? catalog.isError
        ? t`Could not load this connection's models. Try again.`
        : null
      : legacyCatalog.error,
    connection,
    isSaveDisabled:
      (!form.formState.isDirty && apiKeyEdit.kind === 'keep') ||
      (needsSuccessfulTest && connection.status !== 'success'),
    loadCatalog: () => {
      if (model.providerConnectionId) {
        void catalog.refetch()
      } else if (!legacyCatalog.isLoading && canFetchCatalog(legacyCatalogRequest)) {
        void legacyCatalog.fetchCatalog(legacyCatalogRequest)
      }
    },
    selectModel,
    changeUrl: (value: string) => {
      form.setValue('url', value, { shouldValidate: true, shouldDirty: true })
      legacyCatalog.invalidateCatalog()
    },
    changeApiKey: (value: string) => {
      form.setValue('apiKey', value, { shouldDirty: true })
      setApiKeyEdit(value ? { kind: 'replace', value } : { kind: 'keep' })
      legacyCatalog.invalidateCatalog()
    },
    toggleClearApiKey: () => {
      form.setValue('apiKey', '', { shouldDirty: true })
      setApiKeyEdit(apiKeyEdit.kind === 'clear' ? { kind: 'keep' } : { kind: 'clear' })
      legacyCatalog.invalidateCatalog()
    },
    testConnection,
    changeSupportsTools: (checked: boolean) => form.setValue('supportsTools', checked, { shouldDirty: true }),
    submissionFor: ({ supportsTools, apiKey, url, ...values }: EditModelFormValues): EditModelSubmission => ({
      ...values,
      id: model.id,
      toolUsage: supportsTools ? 1 : 0,
      ...(!model.providerConnectionId ? { url, apiKey: apiKeyEditValue(liveApiKeyEdit) } : {}),
    }),
  }
}
