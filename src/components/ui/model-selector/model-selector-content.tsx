import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Model } from '@/types'
import { Lock, Plus, Search, Sparkles, Shield } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CategorizedModels, ModelSelectorProps } from './types'
import type { ChatThread } from '@/layout/sidebar/types'

type ModelSelectorContentProps = Pick<ModelSelectorProps, 'models' | 'selectedModel' | 'chatThread' | 'onAddModels'> & {
  onSelect: (modelId: string) => void
}

const getModelDescription = (model: Model): string => {
  if (model.isConfidential) return 'Fast and confidential'
  if (model.provider === 'anthropic') return 'For complex tasks'
  if (model.provider === 'openrouter') return 'Via OpenRouter'
  if (model.provider === 'openai') return 'OpenAI model'
  return model.model
}

const getModelIcon = (model: Model) => {
  if (model.isConfidential) return <Shield className="size-5 text-muted-foreground" />
  if (model.provider === 'anthropic') return <Sparkles className="size-5 text-muted-foreground" />
  return null
}

const categorizeModels = (models: Model[]): CategorizedModels => {
  const provided: Model[] = []
  const custom: Model[] = []

  for (const model of models) {
    if (model.isSystem) {
      provided.push(model)
    } else {
      custom.push(model)
    }
  }

  return { provided, custom }
}

type ModelItemProps = {
  model: Model
  isSelected: boolean
  isDisabled: boolean
  onSelect: (modelId: string) => void
}

const ModelItem = ({ model, isSelected, isDisabled, onSelect }: ModelItemProps) => {
  const description = getModelDescription(model)
  const icon = getModelIcon(model)

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={() => onSelect(model.id)}
      className={cn(
        'w-full flex items-center justify-between p-3 rounded-lg transition-colors text-left',
        'hover:bg-accent/50 focus:bg-accent/50 focus:outline-none',
        isSelected && 'bg-accent',
        isDisabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{model.name}</span>
          {model.isConfidential === 1 && <Lock className="size-3.5 text-warning-500 flex-shrink-0" />}
        </div>
        <span className="text-sm text-muted-foreground truncate">{description}</span>
      </div>
      {icon && <div className="flex-shrink-0 ml-3">{icon}</div>}
    </button>
  )
}

type ModelSectionProps = {
  title: string
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
  onSelect: (modelId: string) => void
}

const ModelSection = ({ title, models, selectedModel, chatThread, onSelect }: ModelSectionProps) => {
  if (models.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground px-3 py-2">{title}</h3>
      <div className="flex flex-col">
        {models.map((model) => {
          const isDisabled = chatThread ? chatThread.isEncrypted !== model.isConfidential : false
          const isSelected = selectedModel?.id === model.id

          return (
            <ModelItem
              key={model.id}
              model={model}
              isSelected={isSelected}
              isDisabled={isDisabled}
              onSelect={onSelect}
            />
          )
        })}
      </div>
    </div>
  )
}

export const ModelSelectorContent = ({
  models,
  selectedModel,
  chatThread,
  onSelect,
  onAddModels,
}: ModelSelectorContentProps) => {
  const [searchQuery, setSearchQuery] = useState('')

  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models
    const query = searchQuery.toLowerCase()
    return models.filter(
      (model) =>
        model.name.toLowerCase().includes(query) ||
        model.model.toLowerCase().includes(query) ||
        model.provider.toLowerCase().includes(query),
    )
  }, [models, searchQuery])

  const categorized = useMemo(() => categorizeModels(filteredModels), [filteredModels])

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="px-3 pt-3 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search Model"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <ScrollArea className="h-[300px]">
        <div className="flex flex-col gap-4 px-1 pb-1">
          <ModelSection
            title="Provided Models"
            models={categorized.provided}
            selectedModel={selectedModel}
            chatThread={chatThread}
            onSelect={onSelect}
          />

          <ModelSection
            title="Custom Models"
            models={categorized.custom}
            selectedModel={selectedModel}
            chatThread={chatThread}
            onSelect={onSelect}
          />

          {filteredModels.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No models found</div>
          )}
        </div>
      </ScrollArea>

      {onAddModels && (
        <div className="border-t px-3 py-3">
          <button
            type="button"
            onClick={onAddModels}
            className="flex items-center gap-2 text-sm font-medium hover:text-foreground text-muted-foreground transition-colors w-full"
          >
            <Plus className="size-4" />
            Add Models
          </button>
        </div>
      )}
    </div>
  )
}
