import { useSettings } from '@/hooks/use-settings'
import { trackEvent } from '@/lib/posthog'
import { getAvailableModels, getDefaultModelForThread } from '@/dal'
import type { Model } from '@/types'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

export const useChatModel = (id: string) => {
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: getAvailableModels,
  })

  const { selectedModel } = useSettings({
    selected_model: '',
  })

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)

  const selectedModelIdRef = useRef<string | null>(null)

  const { data: defaultModel } = useQuery<Model>({
    queryKey: ['models', 'defaultModel', id],
    queryFn: () => getDefaultModelForThread(id, selectedModel.value ?? undefined),
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

  // Keep ref in sync with state so fetch always sees latest value
  useEffect(() => {
    selectedModelIdRef.current = selectedModelId
  }, [selectedModelId])

  return {
    handleModelChange,
    models,
    selectedModelId,
    selectedModelIdRef,
  }
}
