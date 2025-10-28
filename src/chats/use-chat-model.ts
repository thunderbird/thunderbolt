import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { getAvailableModels, getDefaultModelForThread } from '@/dal'
import type { Model } from '@/types'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

export const useChatModel = (chatThreadId: string) => {
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: getAvailableModels,
  })

  const { selectedModel } = useSettings({
    selected_model: '',
  })

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const { data: defaultModel } = useQuery<Model>({
    queryKey: ['models', 'defaultModel', chatThreadId],
    queryFn: () => getDefaultModelForThread(chatThreadId, selectedModel.value ?? undefined),
  })

  const handleModelChange = useCallback(
    (modelId: string | null) => {
      setSelectedModelId(modelId)
      selectedModel.setValue(modelId)
      trackEvent('model_select', { model: modelId })
    },
    [selectedModel],
  )

  useEffect(() => {
    if (defaultModel) {
      setSelectedModelId(defaultModel.id)
    }
  }, [defaultModel])

  return {
    handleModelChange,
    models,
    selectedModelId,
  }
}
