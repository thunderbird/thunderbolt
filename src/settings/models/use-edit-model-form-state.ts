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
import { catalogToComboboxItems, customModelItem } from './use-model-catalog'

const nameRequired = msg`Name is required.`
const modelNameRequired = msg`Model name is required.`

const editModelFormSchema = (i18n: I18n) =>
  z.object({
    name: z
      .string()
      .trim()
      .min(1, { message: i18n._(nameRequired) }),
    model: z
      .string()
      .trim()
      .min(1, { message: i18n._(modelNameRequired) }),
    supportsTools: z.boolean(),
  })
type EditModelFormValues = z.infer<ReturnType<typeof editModelFormSchema>>
export type EditModelSubmission = { id: string; name: string; model: string; toolUsage: number }

/** Edits model preferences while connection credentials remain in Connections. */
export const useEditModelFormState = (model: Model) => {
  const { i18n, t } = useLingui()
  const db = useDatabase()
  const getProxyFetch = useProxyFetchGetter()
  const form = useForm<EditModelFormValues>({
    resolver: zodResolver(editModelFormSchema(i18n)),
    defaultValues: { name: model.name || '', model: model.model, supportsTools: model.toolUsage !== 0 },
  })
  const watchedModel = form.watch('model')
  const [isCustomModel, setIsCustomModel] = useState(false)
  const catalog = useQuery({
    queryKey: ['provider-models', 'edit', model.providerConnectionId],
    queryFn: () => fetchProviderModels(db, model.providerConnectionId!, getProxyFetch),
    enabled: false,
    retry: false,
  })
  const modelItems = catalogToComboboxItems(catalog.data ?? [])
  if (!modelItems.some((item) => item.id === model.model)) {
    modelItems.unshift({ id: model.model, label: model.model })
  }
  modelItems.push(customModelItem(i18n))
  const config = {
    provider: model.provider,
    model: watchedModel,
    providerConnectionId: model.providerConnectionId,
    apiKey: model.apiKey,
    url: model.url,
    oauthProvider: model.oauthProvider,
  }
  const connection = useModelConnectionTest(config)
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
    isLoadingCatalog: catalog.isFetching,
    catalogError: catalog.isError ? t`Could not load this connection's models. Try again.` : null,
    connection,
    isSaveDisabled: !form.formState.isDirty,
    loadCatalog: () => {
      if (model.providerConnectionId) {
        void catalog.refetch()
      }
    },
    selectModel,
    testConnection,
    changeSupportsTools: (checked: boolean) => form.setValue('supportsTools', checked, { shouldDirty: true }),
    submissionFor: ({ supportsTools, ...values }: EditModelFormValues): EditModelSubmission => ({
      ...values,
      id: model.id,
      toolUsage: supportsTools ? 1 : 0,
    }),
  }
}
