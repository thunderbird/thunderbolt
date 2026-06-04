/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { ChatThread } from '@/layout/sidebar/types'
import type { Model } from '@/types'
import { AlertTriangle, ChevronDown, Lock, Plus } from 'lucide-react'
import { useCallback, useMemo } from 'react'

export type ModelSelectorProps = {
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
  onModelChange: (modelId: string) => void
  onAddModels?: () => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Trigger appearance. `pill` (default) is the rounded standalone style used
   *  in modals; `bordered` matches the chat composer's ModeSelector (squared,
   *  bordered, taller) so the two composer controls read as a pair. */
  variant?: 'pill' | 'bordered'
}

type ModelItemData = {
  model: Model
  disabledByEncryption: boolean
}

/**
 * Models that require an API key but don't have one yet need configuration.
 * Thunderbolt is server-authenticated; custom (OpenAI-compatible) endpoints treat
 * the key as optional; system Tinfoil rows are also server-authenticated (the key
 * is injected by the backend proxy) — none of those flag as missing.
 */
export const needsApiKey = (model: Model) => {
  if (model.provider === 'thunderbolt' || model.provider === 'custom') {
    return false
  }
  if (model.provider === 'tinfoil' && model.isSystem === 1) {
    return false
  }
  return !model.apiKey
}

const toMenuItem = (
  model: Model,
  isDisabled: boolean,
  disabledByEncryption: boolean,
): SearchableMenuItem<ModelItemData> => ({
  id: model.id,
  label: model.name,
  description: model.description || model.model,
  searchTerms: [model.model, model.vendor].filter(Boolean).join(' '),
  icon: model.isConfidential === 1 ? <Lock className="size-3.5 text-green-600 dark:text-green-500" /> : undefined,
  disabled: isDisabled,
  data: { model, disabledByEncryption },
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
    const isDisabledByEncryption = chatThread ? chatThread.isEncrypted !== model.isConfidential : false
    const isDisabled = isDisabledByEncryption || needsApiKey(model)
    const item = toMenuItem(model, isDisabled, isDisabledByEncryption)

    if (isDisabledByEncryption) {
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
  // Models disabled by an encryption mismatch are shown greyed out with no
  // group heading or explanation (only one of these buckets is ever non-empty
  // for a given chat, since the mismatch is one-directional).
  if (disabledStandard.length > 0) {
    groups.push({ id: 'standard-disabled', items: disabledStandard })
  }
  if (disabledConfidential.length > 0) {
    groups.push({ id: 'confidential-disabled', items: disabledConfidential })
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
  variant = 'pill',
}: ModelSelectorProps) => {
  const groupedItems = useMemo(() => categorizeModels(models, chatThread), [models, chatThread])

  const renderTrigger = (selected: SearchableMenuItem<ModelItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center gap-2 px-3 cursor-pointer transition-colors text-[length:var(--font-size-body)]',
        variant === 'bordered'
          ? cn(
              'h-[var(--touch-height-default)] rounded-lg border border-border',
              isOpen ? 'bg-accent' : 'hover:bg-accent/50',
            )
          : cn('h-[var(--touch-height-sm)] rounded-full', isOpen ? 'bg-secondary' : 'hover:bg-secondary/50'),
      )}
    >
      {selected?.data?.model && needsApiKey(selected.data.model) ? (
        <AlertTriangle className="size-3.5 text-amber-500" />
      ) : selected?.data?.model.isConfidential === 1 ? (
        <Lock className="size-3.5 text-muted-foreground" />
      ) : null}
      <span className={cn('font-medium', variant === 'bordered' && 'text-muted-foreground')}>
        {selected?.label ?? 'Select Model'}
      </span>
      <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
    </div>
  )

  const renderItem = (item: SearchableMenuItem<ModelItemData>, isSelected: boolean) => {
    const model = item.data?.model
    // For an encryption-mismatch item the real blocker isn't a missing key, so
    // suppress the missing-key hint (the item is simply shown greyed out).
    const showMissingKeyHint = model ? needsApiKey(model) && !item.data?.disabledByEncryption : false

    const content = (
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
            {showMissingKeyHint ? <AlertTriangle className="size-3.5 text-amber-500 flex-shrink-0" /> : item.icon}
          </div>
          <span className="text-sm text-muted-foreground truncate">{item.description}</span>
        </div>
      </div>
    )

    if (showMissingKeyHint) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{content}</TooltipTrigger>
            <TooltipContent side="right">API key not configured</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    }

    return content
  }

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
