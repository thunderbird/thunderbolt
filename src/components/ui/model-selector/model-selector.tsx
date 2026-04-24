import { Button } from '@/components/ui/button'
import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { SelectorTrigger } from '@/components/ui/selector-trigger'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { ChatThread } from '@/layout/sidebar/types'
import type { Model } from '@/types'
import { Check, Cpu, Lock, Plus } from 'lucide-react'
import { useCallback, useMemo } from 'react'

export type ModelSelectorProps = {
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
  onModelChange: (modelId: string) => void
  onAddModels?: () => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
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
    groups.push({ id: 'provided', items: provided })
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
  side,
  align,
}: ModelSelectorProps) => {
  const groupedItems = useMemo(() => categorizeModels(models, chatThread), [models, chatThread])

  const renderTrigger = (selected: SearchableMenuItem<ModelItemData> | undefined, isOpen: boolean) => (
    <SelectorTrigger
      icon={<Cpu className="size-[var(--icon-size-default)] shrink-0" />}
      label={selected?.label ?? 'Select Model'}
      isOpen={isOpen}
    />
  )

  const renderItem = (item: SearchableMenuItem<ModelItemData>, isSelected: boolean) => (
    <div
      className={cn(
        'w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors text-left cursor-pointer',
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
      {isSelected && <Check className="size-4 text-foreground flex-shrink-0" />}
    </div>
  )

  const footer = onAddModels ? (
    <Button variant="ghost" onClick={onAddModels} className="w-full justify-start gap-2 text-muted-foreground">
      <Plus className="size-4" />
      Add Models
    </Button>
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
      searchable={models.length > 10}
      searchPlaceholder="Search Models"
      emptyMessage="No models found"
      blurBackdrop
      trigger={renderTrigger}
      renderItem={renderItem}
      footer={footer}
      width={320}
      maxHeight={340}
      side={side}
      align={align}
    />
  )
}
