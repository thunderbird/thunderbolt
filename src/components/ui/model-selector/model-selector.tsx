import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { ChatThread } from '@/layout/sidebar/types'
import type { Model } from '@/types'
import { ChevronDown, Lock, Plus } from 'lucide-react'
import { useCallback, useMemo } from 'react'

export type ModelSelectorProps = {
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
  onModelChange: (modelId: string) => void
  onAddModels?: () => void
}

type ModelItemData = {
  model: Model
}

const toMenuItem = (model: Model, isDisabled: boolean): SearchableMenuItem<ModelItemData> => ({
  id: model.id,
  label: model.name,
  description: model.description || model.model,
  searchTerms: [model.model, model.vendor].filter(Boolean).join(' '),
  icon: model.isConfidential === 1 ? <Lock className="size-3.5 text-green-600 dark:text-green-500" /> : undefined,
  disabled: isDisabled,
  data: { model },
})

export const categorizeModels = (
  models: Model[],
  chatThread: ModelSelectorProps['chatThread'],
): SearchableMenuGroup<ModelItemData>[] => {
  const provided: SearchableMenuItem<ModelItemData>[] = []
  const custom: SearchableMenuItem<ModelItemData>[] = []
  const disabledConfidential: SearchableMenuItem<ModelItemData>[] = []
  const disabledStandard: SearchableMenuItem<ModelItemData>[] = []

  for (const model of models) {
    const isDisabled = chatThread ? chatThread.isEncrypted !== model.isConfidential : false
    const item = toMenuItem(model, isDisabled)

    if (isDisabled) {
      if (model.isConfidential === 1) {
        disabledConfidential.push(item)
      } else {
        disabledStandard.push(item)
      }
    } else if (model.isSystem) {
      provided.push(item)
    } else {
      custom.push(item)
    }
  }

  const groups: SearchableMenuGroup<ModelItemData>[] = []

  if (provided.length > 0) {
    groups.push({ id: 'provided', label: 'Provided Models', items: provided })
  }
  if (custom.length > 0) {
    groups.push({ id: 'custom', label: 'Custom Models', items: custom })
  }
  if (disabledStandard.length > 0) {
    groups.push({
      id: 'standard-disabled',
      label: 'Standard Models',
      subtitle: 'Only confidential models can be used in this chat',
      items: disabledStandard,
    })
  }
  if (disabledConfidential.length > 0) {
    groups.push({
      id: 'confidential-disabled',
      label: 'Confidential Models',
      subtitle: 'Only available in confidential chats',
      items: disabledConfidential,
    })
  }

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
        'flex items-center gap-2 px-[var(--spacing-x-md)] h-[var(--touch-height-sm)] rounded-full cursor-pointer transition-colors text-[length:var(--font-size-body)]',
        isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      {selected?.data?.model.isConfidential === 1 && <Lock className="size-3.5 text-muted-foreground" />}
      <span className="font-medium">{selected?.label ?? 'Select Model'}</span>
      <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
    </div>
  )

  const renderItem = (item: SearchableMenuItem<ModelItemData>, isSelected: boolean) => (
    <div
      className={cn(
        'w-full flex items-center justify-between px-[var(--spacing-x-md)] py-[var(--spacing-y-default)] rounded-[var(--radius-xl)] transition-colors text-left cursor-pointer',
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

  const { triggerSelection } = useHaptics()
  const handleModelChange = useCallback(
    (id: string) => {
      triggerSelection()
      onModelChange(id)
    },
    [onModelChange, triggerSelection],
  )

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
