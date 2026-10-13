/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { thunderboltModelCatalog } from '@/settings/models/model-catalog'
import { catalogToComboboxItems, customModelItem } from '@/settings/models/use-model-catalog'
import {
  createAddModelFormSchema,
  generateModelName,
  type AddModelFormValues,
} from '@/settings/models/use-add-model-form'
import type { CompanyModel } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'

/** Local model configuration using the same provider catalog, schema and form as user settings. */
export const useCompanyModelEditorState = ({
  model,
  preview,
  onSaved,
  onDirtyChange,
}: {
  model?: CompanyModel
  preview: AdminPreview
  onSaved: () => void
  onDirtyChange: (dirty: boolean) => void
}) => {
  const { i18n, t } = useLingui()
  const knownModel =
    model?.provider === 'thunderbolt' && thunderboltModelCatalog.some((item) => item.id === model.model)
  const [selectedModelId, setSelectedModelId] = useState(model ? (knownModel ? model.model : 'custom') : '')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const form = useForm<AddModelFormValues>({
    resolver: zodResolver(createAddModelFormSchema(i18n, { configurationOnly: true })),
    mode: 'onChange',
    defaultValues: {
      provider: model?.provider ?? 'thunderbolt',
      name: model?.name ?? '',
      model: model?.model ?? '',
      customModel: model?.model ?? '',
      url: model?.url ?? '',
      apiKey: '',
    },
  })
  const provider = form.watch('provider')
  const catalog = provider === 'thunderbolt' ? thunderboltModelCatalog : []
  const modelItems = [...catalogToComboboxItems(catalog), customModelItem(i18n)]
  const changed = () => {
    setSubmitError(null)
    onDirtyChange(true)
  }
  const onProviderChange = (provider: CompanyModel['provider']) => {
    form.reset({
      provider,
      name: '',
      model: '',
      customModel: '',
      url: provider === 'custom' ? 'http://localhost:11434/v1' : '',
      apiKey: '',
    })
    setSelectedModelId(provider === 'thunderbolt' ? '' : 'custom')
    changed()
  }
  const onSelectModel = (id: string) => {
    setSelectedModelId(id)
    changed()
    if (id === 'custom') {
      form.setValue('customModel', form.getValues('model'), { shouldDirty: true })
      return
    }
    const selected = catalog.find((candidate) => candidate.id === id)
    form.setValue('model', id, { shouldDirty: true, shouldValidate: true })
    form.setValue('name', selected?.name ?? generateModelName(id), { shouldDirty: true, shouldValidate: true })
    form.setValue('customModel', '')
  }
  const onSubmit = (values: AddModelFormValues) => {
    const url = values.provider === 'custom' ? values.url?.trim() || null : null
    if (
      preview.companyModels.some(
        (item) =>
          item.id !== model?.id && item.provider === values.provider && item.model === values.model && item.url === url,
      )
    ) {
      setSubmitError(t`This model is already configured for this provider.`)
      return
    }
    preview.dispatch({
      type: 'save-model',
      model: {
        id: model?.id ?? crypto.randomUUID(),
        provider: values.provider,
        name: values.name,
        model: values.model,
        url,
        enabled: model?.enabled ?? 1,
        deletedAt: null,
      },
    })
    onSaved()
  }
  return {
    form,
    selectedModelId,
    modelItems,
    onProviderChange,
    onSelectModel,
    onSubmit,
    submitError,
    changed,
    supportsTools: catalog.find((item) => item.id === selectedModelId)?.supports_tools !== false,
  }
}
