import type { ChatThread } from '@/layout/sidebar/types'
import type { Model } from '@/types'

export type ModelSelectorProps = {
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
  onModelChange: (modelId: string) => void
  onAddModels?: () => void
}
