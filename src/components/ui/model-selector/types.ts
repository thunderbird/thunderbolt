import type { Model } from '@/types'
import type { ChatThread } from '@/layout/sidebar/types'

export type ModelSelectorProps = {
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
  onModelChange: (modelId: string) => void
  onAddModels?: () => void
}

export type CategorizedModels = {
  provided: Model[]
  custom: Model[]
}
