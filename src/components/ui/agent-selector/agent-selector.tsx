/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  SearchableMenu,
  searchableMenuFooterActionClass,
  searchableMenuRowClass,
  type SearchableMenuItem,
} from '@/components/ui/searchable-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'
import { iconForAgent } from '@/components/agent-icon'
import { ChevronDown, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

export type AgentSelectorProps = {
  selectedAgent: Agent
  agents: Agent[]
  onSelect: (agent: Agent) => void
  onAddAgent?: () => void
  disabled?: boolean
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
    // The logo reads slightly smaller than the lucide glyphs at equal box
    // size, so it gets a half-step bump.
    icon: <Icon className={cn('text-muted-foreground', agent.type === 'built-in' ? 'size-4' : 'size-3.5')} />,
    data: { agent },
  }
}

/** Compact item renderer — label-only rows (no descriptions) at
 *  `--font-size-body` (16px mobile / 14px desktop) so the menu stays tight. */
const renderAgentItem = (item: SearchableMenuItem<AgentItemData>, isSelected: boolean) => (
  <div className={cn(searchableMenuRowClass, isSelected ? 'bg-accent' : 'hover:bg-accent/50')}>
    {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
    <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
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
  collapsed = false,
  side,
  align,
}: AgentSelectorProps) => {
  const items = useMemo(() => buildAgentItems(agents), [agents])
  const [open, setOpen] = useState(false)
  const { triggerSelection } = useHaptics()

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
        aria-disabled={disabled}
        className={cn(
          'group relative h-[var(--touch-height-sm)] max-w-[50vw] text-[length:var(--font-size-body)] max-md:h-[var(--touch-height-lg)] md:max-w-none',
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        {/* The fixed-width labeled pill is never resized. On mobile it simply
            fades away while its parent slides right, avoiding all per-frame
            layout work and truncation artifacts. It remains in flow (and
            therefore keeps the trigger width stable) while transparent. */}
        <div
          className={cn(
            'relative z-10 flex h-full items-center rounded-full px-3 transition-[opacity,background-color,color] duration-150',
            collapsed ? 'opacity-0' : 'opacity-100',
            !disabled && isOpen
              ? 'bg-secondary'
              : !collapsed && 'hover:bg-accent max-md:group-active:bg-muted-foreground/20 dark:hover:bg-secondary/50',
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
          <ChevronDown
            className={cn(
              'ml-2 size-3.5 shrink-0 text-muted-foreground transition-transform max-md:hidden',
              !disabled && isOpen && 'rotate-180',
            )}
          />
        </div>

        {/* Independent logo-only circle beneath the pill. Crossfading these
            layers means the moving element never changes width; only opacity
            and the header wrapper's translate animate. */}
        <div
          aria-hidden="true"
          data-testid="agent-selector-collapsed-circle"
          className={cn(
            'pointer-events-none absolute right-0 top-0 z-0 flex size-[var(--touch-height-lg)] items-center justify-center rounded-full bg-muted/80 transition-opacity duration-150 group-active:bg-muted-foreground/20 dark:bg-muted/40 md:hidden',
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
          {disabled && <TooltipContent side="bottom">Cannot change agent during reply</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
    )
  }

  const footer = onAddAgent ? (
    <button
      type="button"
      onClick={() => {
        setOpen(false)
        onAddAgent()
      }}
      className={searchableMenuFooterActionClass}
    >
      <Plus className="size-4" />
      Add agent
    </button>
  ) : undefined

  return (
    <SearchableMenu
      items={items}
      value={selectedAgent.id}
      onValueChange={handleAgentChange}
      searchable={agents.length > 10}
      searchPlaceholder="Search agents"
      emptyMessage="No agents found"
      mobileTitle="Choose agent"
      mobileSide="top"
      trigger={renderTrigger}
      renderItem={renderAgentItem}
      footer={footer}
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
