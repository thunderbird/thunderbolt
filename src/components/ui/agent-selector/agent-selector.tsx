/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { SearchableMenu, searchableMenuRowClass, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'
import { getAgentDescription } from '@/components/agent-description'
import { iconForAgent } from '@/components/agent-icon'
import { mobileHeaderControlFillClass } from '@/components/ui/modal-styles'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

export type AgentSelectorProps = {
  selectedAgent: Agent
  agents: Agent[]
  onSelect: (agent: Agent) => void
  onAddAgent?: () => void
  disabled?: boolean
  /** An existing chat keeps its agent; display its identity without a menu. */
  readOnly?: boolean
  /** Collapses the trigger into a circular icon-only button (the mobile
   *  header's top-right control, matching the sidebar toggle's muted circle).
   *  The label and paddings transition, so toggling this mid-mount morphs the
   *  pill smoothly instead of swapping shapes. */
  collapsed?: boolean
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

type AgentItemData = {
  agent: Agent
}

const toMenuItem = (agent: Agent): SearchableMenuItem<AgentItemData> => {
  const Icon = iconForAgent(agent)
  return {
    id: agent.id,
    label: agent.name,
    description: agent.description ?? undefined,
    // The logo reads slightly smaller than the lucide glyphs at equal box
    // size, so it gets a half-step bump.
    icon: <Icon className={cn('text-muted-foreground', agent.type === 'built-in' ? 'size-4' : 'size-3.5')} />,
    data: { agent },
  }
}

/** Keep the name prominent and the short description on a quieter second line. */
const renderAgentItem = (item: SearchableMenuItem<AgentItemData>, isSelected: boolean) => (
  <div
    className={cn(searchableMenuRowClass, 'h-auto py-2 max-md:h-auto', isSelected ? 'bg-accent' : 'hover:bg-accent/50')}
  >
    {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{item.label}</span>
      {item.description && (
        <span className="mt-0.5 block text-[length:var(--font-size-xs)] leading-snug text-muted-foreground line-clamp-2">
          {item.description}
        </span>
      )}
    </span>
  </div>
)

/** Flatten agents into one unlabeled list. Order mirrors `composeAllAgents`:
 *  Built-in → System → Custom — no section headers, the flavors just read as
 *  one continuous menu. */
export const buildAgentItems = (agents: Agent[]): SearchableMenuItem<AgentItemData>[] => {
  const builtIn: SearchableMenuItem<AgentItemData>[] = []
  const system: SearchableMenuItem<AgentItemData>[] = []
  const custom: SearchableMenuItem<AgentItemData>[] = []

  for (const agent of agents) {
    const item = toMenuItem(agent)
    if (agent.type === 'built-in') {
      builtIn.push(item)
    } else if (agent.isSystem === 1) {
      system.push(item)
    } else {
      custom.push(item)
    }
  }

  return [...builtIn, ...system, ...custom]
}

export const AgentSelector = ({
  selectedAgent,
  agents,
  onSelect,
  onAddAgent,
  disabled = false,
  readOnly = false,
  collapsed = false,
  side,
  align,
}: AgentSelectorProps) => {
  const { t, i18n } = useLingui()
  const items = buildAgentItems(agents).map((item) => ({
    ...item,
    description: item.data ? getAgentDescription(item.data.agent, i18n) : item.description,
  }))

  const [open, setOpen] = useState(false)
  const { triggerSelection } = useHaptics()

  const soleAgentIsOther = agents.length === 1 && agents[0].id !== selectedAgent.id
  const isLabel = readOnly || (!soleAgentIsOther && agents.length <= 1 && !onAddAgent)
  const dimmed = disabled && !isLabel

  const handleAgentChange = (_id: string, item: SearchableMenuItem<AgentItemData>) => {
    const agent = item.data?.agent
    if (!agent) {
      return
    }
    triggerSelection()
    onSelect(agent)
  }

  const renderTrigger = (selected: SearchableMenuItem<AgentItemData> | undefined, isOpen: boolean) => {
    const triggerAgent = selected?.data?.agent ?? selectedAgent
    const Icon = iconForAgent(triggerAgent)
    const triggerInner = (
      <div
        data-testid="agent-selector-trigger"
        aria-disabled={dimmed}
        className={cn(
          'group relative h-[var(--touch-height-sm)] max-w-[50vw] text-[length:var(--font-size-body)] max-md:h-[var(--touch-height-lg)] md:max-w-none',
          isLabel && 'cursor-default',
          dimmed && 'opacity-60 cursor-not-allowed',
          !isLabel && !dimmed && 'cursor-pointer',
        )}
      >
        {/* The fixed-width labeled pill is never resized. On mobile it simply
            fades away while its parent slides right, avoiding all per-frame
            layout work and truncation artifacts. It remains in flow (and
            therefore keeps the trigger width stable) while transparent. */}
        <div
          data-testid="agent-selector-pill"
          className={cn(
            'relative z-10 flex h-full items-center rounded-full px-4 transition-[opacity,background-color,color] duration-150 md:px-3',
            mobileHeaderControlFillClass,
            collapsed ? 'opacity-0' : 'opacity-100',
            !dimmed && isOpen
              ? 'bg-secondary'
              : !collapsed &&
                  !isLabel &&
                  'hover:bg-accent max-md:group-active:bg-muted-foreground/20 dark:hover:bg-secondary/50',
          )}
        >
          <Icon
            className={cn(
              'max-w-none shrink-0 text-muted-foreground',
              triggerAgent.type === 'built-in' ? 'size-4' : 'size-3.5',
            )}
          />
          <span className="min-w-0 truncate pl-2 font-medium text-muted-foreground">
            {selected?.label ?? selectedAgent.name}
          </span>
          {/* Hidden on mobile: the menu opens as an animated card there, so the
              chevron affordance is redundant. */}
          {!isLabel && (
            <ChevronDown
              className={cn(
                'ml-2 size-3.5 shrink-0 text-muted-foreground transition-transform max-md:hidden',
                !dimmed && isOpen && 'rotate-180',
              )}
            />
          )}
        </div>

        {/* Independent logo-only circle beneath the pill. Crossfading these
            layers means the moving element never changes width; only opacity
            and the header wrapper's translate animate. */}
        <div
          aria-hidden="true"
          data-testid="agent-selector-collapsed-circle"
          className={cn(
            'pointer-events-none absolute right-0 top-0 z-0 flex size-[var(--touch-height-lg)] items-center justify-center rounded-full transition-opacity duration-150 max-md:group-active:bg-muted-foreground/20 md:hidden',
            mobileHeaderControlFillClass,
            collapsed ? 'opacity-100' : 'opacity-0',
          )}
        >
          <Icon className="max-w-none size-[var(--icon-size-default)] text-muted-foreground" />
        </div>
      </div>
    )

    // Keep the wrapper mounted when `disabled` changes on send; remounting the
    // trigger would cancel its slide and crossfade.
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{triggerInner}</TooltipTrigger>
          {dimmed && (
            <TooltipContent side="bottom">
              <Trans>Cannot change agent during reply</Trans>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
    )
  }

  const footerAction = onAddAgent ? { label: t`Add Agent`, onAction: onAddAgent } : undefined

  if (isLabel) {
    return renderTrigger(undefined, false)
  }

  return (
    <SearchableMenu
      items={items}
      value={selectedAgent.id}
      onValueChange={handleAgentChange}
      searchable={agents.length > 10}
      searchPlaceholder={t`Search agents`}
      emptyMessage={t`No agents found`}
      mobileTitle={t`Choose agent`}
      mobileSide="top"
      trigger={renderTrigger}
      renderItem={renderAgentItem}
      footerAction={footerAction}
      width={240}
      maxHeight={340}
      side={side}
      align={align}
      open={disabled ? false : open}
      onOpenChange={(next) => {
        if (disabled) {
          return
        }
        setOpen(next)
      }}
    />
  )
}
