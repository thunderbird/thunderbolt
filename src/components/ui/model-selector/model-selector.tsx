/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { I18n } from '@lingui/core'
import {
  SearchableMenu,
  searchableMenuRowClass,
  type SearchableMenuGroup,
  type SearchableMenuItem,
} from '@/components/ui/searchable-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { GradientLock } from '@/components/ui/gradient-lock'
import { PrivateBadge } from '@/components/ui/private-badge'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import { needsApiKey } from '@/settings/models/model-policy'
import type { ChatThread } from '@/layout/sidebar/types'
import type { Model } from '@/types'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useCallback } from 'react'

export type ModelSelectorProps = {
  models: Model[]
  selectedModel: Model | null
  chatThread: ChatThread | null
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
  disabledByEncryption: boolean
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
  icon: model.isConfidential === 1 ? <PrivateBadge /> : undefined,
  disabled: isDisabled,
  data: { model, disabledByEncryption },
})

const disabledStandardLabel = msg`Not available in private chats.`
const disabledConfidentialLabel = msg`Only available in private chats.`

export const categorizeModels = (
  models: Model[],
  chatThread: ModelSelectorProps['chatThread'],
  i18n: I18n,
): SearchableMenuGroup<ModelItemData>[] => {
  // Custom and built-in models share one group — the selector only splits by
  // confidentiality (available vs the greyed-out opposite-mode section below).
  const available: SearchableMenuItem<ModelItemData>[] = []
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
    } else {
      available.push(item)
    }
  }

  const groups: SearchableMenuGroup<ModelItemData>[] = []

  if (available.length > 0) {
    groups.push({ id: 'available', items: available })
  }
  // A chat is locked to its confidentiality mode, so the opposite-mode models
  // are shown greyed out with a header explaining why. Only one of these
  // buckets is ever non-empty for a given chat.
  if (disabledStandard.length > 0) {
    groups.push({
      id: 'standard-disabled',
      label: i18n._(disabledStandardLabel),
      items: disabledStandard,
    })
  }
  if (disabledConfidential.length > 0) {
    groups.push({
      id: 'confidential-disabled',
      label: i18n._(disabledConfidentialLabel),
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
  variant = 'pill',
}: ModelSelectorProps) => {
  const { t, i18n } = useLingui()
  // Computed during render rather than memoized: `useLingui` returns the same
  // `i18n` singleton across a language switch, so an `i18n` dependency never
  // invalidates and the disabled-group labels would stay in the outgoing
  // locale until `models`/`chatThread` happened to change. Partitioning the
  // model list is cheap; see the Localization section in AGENTS.md.
  const groupedItems = categorizeModels(models, chatThread, i18n)

  const renderTrigger = (selected: SearchableMenuItem<ModelItemData> | undefined, isOpen: boolean) => (
    <div
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
      ) : selected?.data?.model.isConfidential === 1 ? (
        <GradientLock className="size-3.5 shrink-0" />
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
    // For an encryption-mismatch item the real blocker isn't a missing key, so
    // suppress the missing-key hint (the item is simply shown greyed out).
    const showMissingKeyHint = model ? needsApiKey(model) && !item.data?.disabledByEncryption : false

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
        {/* ml-auto pushes the trailing indicator (missing-key warning or the
            confidential "Private" badge) to the row's right edge. */}
        {showMissingKeyHint ? (
          <AlertTriangle className="ml-auto size-3.5 flex-shrink-0 text-amber-500" />
        ) : item.icon ? (
          <span className="ml-auto flex-shrink-0">{item.icon}</span>
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
