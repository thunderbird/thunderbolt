import { SearchableMenu, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import type { ChatThread } from '@/layout/sidebar/types'
import { cn } from '@/lib/utils'
import type { Model } from '@/types'
import { ChevronDown, Lock } from 'lucide-react'
import { memo, useMemo } from 'react'

type ModelSelectProps = {
  chatThread: ChatThread | null
  models: Model[]
  selectedModelId?: string
  onModelChange: (model: string | null) => void
}

type ModelItemData = {
  model: Model
  isDisabled: boolean
}

/**
 * Simple model selection dropdown for use in forms like automation modal.
 * Uses SearchableMenu without search functionality.
 * For the main chat interface with search, use ModelSelector from ./model-selector instead.
 */
export const ModelSelect = memo(({ chatThread, models, selectedModelId, onModelChange }: ModelSelectProps) => {
  const items = useMemo((): SearchableMenuItem<ModelItemData>[] => {
    return models.map((model) => {
      const isDisabled = chatThread ? chatThread.isEncrypted !== model.isConfidential : false
      return {
        id: model.id,
        label: model.name,
        icon: model.isConfidential === 1 ? <Lock className="size-3.5" /> : undefined,
        disabled: isDisabled,
        data: { model, isDisabled },
      }
    })
  }, [models, chatThread])

  const renderTrigger = (selected: SearchableMenuItem<ModelItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-[var(--spacing-x-md)] py-[var(--spacing-y-md)] rounded-[var(--radius-xl)] cursor-pointer transition-colors text-[length:var(--font-size-body)] border h-[var(--touch-height-default)] min-w-[140px]',
        isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      <div className="flex items-center gap-2 truncate">
        {selected?.icon}
        <span className="truncate">{selected?.label ?? 'Select a model'}</span>
      </div>
      <ChevronDown
        className={cn('size-3.5 text-muted-foreground transition-transform flex-shrink-0', isOpen && 'rotate-180')}
      />
    </div>
  )

  const handleChange = (id: string) => {
    onModelChange(id)
  }

  return (
    <SearchableMenu
      items={items}
      value={selectedModelId}
      onValueChange={handleChange}
      searchable={false}
      blurBackdrop={false}
      trigger={renderTrigger}
      width={220}
      maxHeight={250}
    />
  )
})

ModelSelect.displayName = 'ModelSelect'
