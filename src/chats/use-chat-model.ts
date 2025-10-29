import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { getDefaultModelForThread } from '@/dal'
import type { Model } from '@/types'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useChatData } from './chat-data-provider'

export const useChatModel = () => {
  const { id: chatThreadId, models } = useChatData()

  const { selectedModel: selectedModelSetting } = useSettings({
    selected_model: '',
  })

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const { data: defaultModel } = useQuery<Model>({
    queryKey: ['models', 'defaultModel', chatThreadId],
    queryFn: () => getDefaultModelForThread(chatThreadId, selectedModelSetting.value ?? undefined),
  })

  const selectedModel = useMemo(
    () => models.find((m) => m.id === selectedModelId) || models[0],
    [models, selectedModelId],
  )

  const handleModelChange = useCallback(
    (modelId: string | null) => {
      setSelectedModelId(modelId)
      selectedModelSetting.setValue(modelId)
      trackEvent('model_select', { model: modelId })
    },
    [selectedModelSetting],
  )

  useEffect(() => {
    if (defaultModel) {
      setSelectedModelId(defaultModel.id)
    }
  }, [defaultModel])

  return {
    handleModelChange,
    selectedModel,
  }
}
