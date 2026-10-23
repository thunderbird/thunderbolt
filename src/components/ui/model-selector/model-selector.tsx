/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import {
  SearchableMenu,
  searchableMenuRowClass,
  type SearchableMenuGroup,
  type SearchableMenuItem,
} from '@/components/ui/searchable-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import { needsApiKey } from '@/settings/models/model-policy'
import type { Model } from '@/types'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useCallback } from 'react'

export type ModelSelectorProps = {
  models: Model[]
  selectedModel: Model | null
  onModelChange: (modelId: string) => void
  onAddModels?: () => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Trigger appearance. `pill` (default) is the rounded standalone style used
   *  in modals; `composer` matches the chat composer's ModeSelector (squared,
   *  borderless, hover-accent) so the two composer controls read as a pair. */
  variant?: 'pill' | 'composer'
}

type ModelItemData = {
  model: Model
}

/** Build one model group; agent policy is applied before models reach the picker. */
export const categorizeModels = (models: Model[]): SearchableMenuGroup<ModelItemData>[] =>
  models.length === 0
    ? []
    : [
        {
          id: 'available',
          items: models.map((model) => ({
            id: model.id,
            label: model.name,
            description: model.description || model.model,
            searchTerms: [model.model, model.vendor].filter(Boolean).join(' '),
            disabled: needsApiKey(model),
            data: { model },
          })),
        },
      ]

export const ModelSelector = ({
  models,
  selectedModel,
  onModelChange,
  onAddModels,
  side,
  align,
  variant = 'pill',
}: ModelSelectorProps) => {
  const { t } = useLingui()
  const groupedItems = categorizeModels(models)

  const renderTrigger = (selected: SearchableMenuItem<ModelItemData> | undefined, isOpen: boolean) => (
    <div
      data-testid="model-selector-trigger"
      className={cn(
        'flex min-w-0 items-center cursor-pointer transition-colors',
        variant === 'composer'
          ? cn(
              'gap-1.5 px-2 h-[var(--touch-height-control)] rounded-[var(--radius-control)] text-[length:var(--font-size-sm)]',
              isOpen ? 'bg-accent' : 'hover:bg-accent/50',
            )
          : cn(
              'gap-2 px-3 h-[var(--touch-height-sm)] rounded-full text-[length:var(--font-size-body)]',
              isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
            ),
      )}
    >
      {selected?.data?.model && needsApiKey(selected.data.model) ? (
        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
      ) : null}
      {/* Muted in both variants — trigger labels are chrome, not content.
          Truncates instead of wrapping when the composer gets narrow. */}
      <span className="min-w-0 truncate font-medium text-muted-foreground">{selected?.label ?? t`Select model`}</span>
      <ChevronDown
        className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')}
      />
    </div>
  )

  const renderItem = (item: SearchableMenuItem<ModelItemData>, isSelected: boolean) => {
    const model = item.data?.model
    const showMissingKeyHint = model ? needsApiKey(model) : false

    const content = (
      <div
        className={cn(
          searchableMenuRowClass,
          'hover:bg-accent/50',
          isSelected && 'bg-accent',
          item.disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span className="truncate font-normal">{item.label}</span>
        {showMissingKeyHint ? <AlertTriangle className="ml-auto size-3.5 flex-shrink-0 text-amber-500" /> : null}
      </div>
    )

    if (showMissingKeyHint) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{content}</TooltipTrigger>
            <TooltipContent side="right">{t`API key not configured`}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    }

    return content
  }

  const footerAction = onAddModels ? { label: t`Add Model`, onAction: onAddModels } : undefined

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
      searchPlaceholder={t`Search Models`}
      emptyMessage={t`No models found`}
      mobileTitle={t`Choose model`}
      mobileSide="bottom"
      trigger={renderTrigger}
      renderItem={renderItem}
      footerAction={footerAction}
      contentClassName="max-md:bg-sidebar"
      width={240}
      maxHeight={340}
      side={side}
      align={align}
    />
  )
}
