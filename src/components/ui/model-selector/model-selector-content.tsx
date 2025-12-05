import { Input } from '@/components/ui/input'
import type { ChatThread } from '@/layout/sidebar/types'
import { cn } from '@/lib/utils'
import type { Model } from '@/types'
import { Lock, Plus, Search } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import type { CategorizedModels, ModelSelectorProps } from './types'

type ModelSelectorContentProps = Pick<ModelSelectorProps, 'models' | 'selectedModel' | 'chatThread' | 'onAddModels'> & {
  onSelect: (modelId: string) => void
}

const getModelDescription = (model: Model): string => {
  if (model.description) return model.description
  return model.model
}

/** Returns the provider logo path for system models with a vendor */
// const getProviderLogoPath = (model: Model): string | null => {
//   if (!model.isSystem || !model.vendor) return null
//   return `/providers/${model.vendor}.svg`
// }

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

const ModelItem = memo(({ model, isSelected, isDisabled, onSelect }: ModelItemProps) => {
  const description = getModelDescription(model)
  // const logoPath = getProviderLogoPath(model)

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={() => onSelect(model.id)}
      className={cn(
        'w-full flex items-center justify-between px-3 py-2 mt-1.5 rounded-lg transition-colors text-left cursor-pointer',
        'hover:bg-accent/50 focus:bg-accent/50 focus:outline-none',
        isSelected && 'bg-accent',
        isDisabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{model.name}</span>
          {model.isConfidential === 1 && <Lock className="size-3.5 text-amber-500 flex-shrink-0" />}
        </div>
        <span className="text-sm text-muted-foreground truncate">{description}</span>
      </div>
      {/* TODO: Re-enable provider logos once we have proper definition on that
      {logoPath && <img src={logoPath} alt={`${model.provider} logo`} className="size-8 flex-shrink-0 ml-3" />}
      */}
    </button>
  )
})
ModelItem.displayName = 'ModelItem'

type ModelSectionProps = {
  title: string
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
  onSelect: (modelId: string) => void
}

const ModelSection = memo(({ title, models, selectedModel, chatThread, onSelect }: ModelSectionProps) => {
  if (models.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground px-3 pt-2">{title}</h3>
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
})
ModelSection.displayName = 'ModelSection'

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
    <div className="flex flex-col gap-2 bg-background rounded-xl">
      <div className="px-4 pt-4">
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

      <div className="h-[300px] overflow-y-auto">
        <div className="flex flex-col gap-4 px-2 pb-2">
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
      </div>

      {onAddModels && (
        <div className="border-t px-4 py-4">
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
