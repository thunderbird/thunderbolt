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
import { AlertTriangle, Check, ChevronDown, Lock, Plus } from 'lucide-react'
import { useCallback } from 'react'
import { flushSync } from 'react-dom'

export type ModelSelectorProps = {
  /** Show the model list directly inside a combined picker. */
  embedded?: boolean
  onClose?: () => void
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
  embedded = false,
  onClose,
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
        <AlertTriangle className="size-3.5 shrink-0 text-warning" />
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
          embedded && 'text-foreground/80',
          isSelected && 'bg-accent',
          item.disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span className="truncate font-normal">{item.label}</span>
        {embedded && isSelected && <Check aria-hidden="true" className="size-3.5 shrink-0 text-brand" />}
        {/* ml-auto pushes the trailing indicator (missing-key warning or the
            confidential "Private" badge) to the row's right edge. */}
        {showMissingKeyHint ? (
          <AlertTriangle className="ml-auto size-3.5 flex-shrink-0 text-warning" />
        ) : item.icon ? (
          <span className="ml-auto flex-shrink-0">
            {embedded ? <Lock aria-label={t`Private`} className="size-3.5 text-muted-foreground" /> : item.icon}
          </span>
        ) : null}
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
    <>
      {embedded && (
        <div className="flex shrink-0 items-center justify-between pl-3 pr-4 pt-2 pb-1">
          <span className="text-[length:var(--font-size-xs)] font-medium text-muted-foreground">{t`Model`}</span>
          {onAddModels && (
            <span className="flex w-3.5 shrink-0 items-center justify-center">
              <button
                type="button"
                aria-label={t`Add Model`}
                title={t`Add Model`}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full max-md:size-10 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  flushSync(() => onClose?.())
                  onAddModels()
                }}
              >
                <Plus aria-hidden="true" className="size-4" />
              </button>
            </span>
          )}
        </div>
      )}
      <SearchableMenu
        embedded={embedded}
        onOpenChange={(open) => {
          if (!open) {
            onClose?.()
          }
        }}
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
        footerAction={embedded ? undefined : footerAction}
        contentClassName="max-md:bg-sidebar"
        width={240}
        maxHeight={embedded ? 220 : 340}
        side={side}
        align={align}
      />
    </>
  )
}
