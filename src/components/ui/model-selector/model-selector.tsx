import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Model } from '@/types'
import { ChevronDown, Lock, Plus } from 'lucide-react'
import { useMemo } from 'react'
import type { ModelSelectorProps } from './types'

type ModelItemData = {
  model: Model
  disabledReason?: string
}

const categorizeModels = (
  models: Model[],
  chatThread: ModelSelectorProps['chatThread'],
): SearchableMenuGroup<ModelItemData>[] => {
  const provided: SearchableMenuItem<ModelItemData>[] = []
  const custom: SearchableMenuItem<ModelItemData>[] = []

  for (const model of models) {
    const isDisabled = chatThread ? chatThread.isEncrypted !== model.isConfidential : false

    const getDisabledReason = () => {
      if (!isDisabled) return undefined
      if (model.isConfidential === 1) return 'This model is only available in confidential chats'
      return 'Non-confidential models cannot be used in confidential chats'
    }

    const item: SearchableMenuItem<ModelItemData> = {
      id: model.id,
      label: model.name,
      description: model.description || model.model,
      searchTerms: [model.model, model.vendor].filter(Boolean).join(' '),
      icon: model.isConfidential === 1 ? <Lock className="size-3.5 text-green-600 dark:text-green-500" /> : undefined,
      disabled: isDisabled,
      data: { model, disabledReason: getDisabledReason() },
    }

    if (model.isSystem) {
      provided.push(item)
    } else {
      custom.push(item)
    }
  }

  const groups: SearchableMenuGroup<ModelItemData>[] = []
  if (provided.length > 0) groups.push({ id: 'provided', label: 'Provided Models', items: provided })
  if (custom.length > 0) groups.push({ id: 'custom', label: 'Custom Models', items: custom })

  return groups
}

export const ModelSelector = ({
  models,
  selectedModel,
  chatThread,
  onModelChange,
  onAddModels,
}: ModelSelectorProps) => {
  const groupedItems = useMemo(() => categorizeModels(models, chatThread), [models, chatThread])

  const renderTrigger = (selected: SearchableMenuItem<ModelItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer transition-colors text-sm',
        isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      {selected?.data?.model.isConfidential === 1 && <Lock className="size-3.5 text-muted-foreground" />}
      <span className="font-medium">{selected?.label ?? 'Select Model'}</span>
      <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
    </div>
  )

  const renderItem = (item: SearchableMenuItem<ModelItemData>, isSelected: boolean) => {
    const content = (
      <div
        className={cn(
          'w-full flex items-center justify-between px-3 py-2 mt-1.5 rounded-lg transition-colors text-left cursor-pointer',
          'hover:bg-accent/50',
          isSelected && 'bg-accent',
          item.disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{item.label}</span>
            {item.icon}
          </div>
          <span className="text-sm text-muted-foreground truncate">{item.description}</span>
        </div>
      </div>
    )

    if (item.disabled && item.data?.disabledReason) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div>{content}</div>
          </TooltipTrigger>
          <TooltipContent side="right">{item.data.disabledReason}</TooltipContent>
        </Tooltip>
      )
    }

    return content
  }

  const footer = onAddModels ? (
    <button
      type="button"
      onClick={onAddModels}
      className="flex items-center gap-2 text-sm font-medium hover:text-foreground text-muted-foreground transition-colors w-full cursor-pointer"
    >
      <Plus className="size-4" />
      Add Models
    </button>
  ) : undefined

  const handleModelChange = (id: string) => {
    onModelChange(id)
  }

  return (
    <SearchableMenu
      items={groupedItems}
      value={selectedModel?.id}
      onValueChange={handleModelChange}
      searchPlaceholder="Search Models"
      emptyMessage="No models found"
      blurBackdrop
      trigger={renderTrigger}
      renderItem={renderItem}
      footer={footer}
      width={320}
      maxHeight={340}
    />
  )
}
