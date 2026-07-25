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
          // Spacing between icon / label / chevron lives on the children
          // (label `pl-2`, chevron `ml-2`) rather than a row gap, so the
          // label's width-collapse below removes its spacing along with it.
          'flex h-[var(--touch-height-sm)] items-center rounded-full text-[length:var(--font-size-body)] transition-[background-color,color,padding] duration-300 max-md:h-[var(--touch-height-lg)] max-md:backdrop-blur-md max-md:active:bg-muted-foreground/20',
          // Collapsed: px + icon add up to --touch-height-lg (14+20+14 = 48px
          // mobile) so the pill lands as a circle matching the header's other
          // round controls.
          collapsed ? 'px-3.5' : 'max-w-[50vw] px-3 md:max-w-none',
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
          // Light secondary is nearly the same shade as the page background,
          // so at 50% the hover reads as invisible — use full accent there
          // (same hover as the header's ghost buttons). Dark keeps the
          // subtler half-secondary. Collapsed rests on the same frosted fill
          // as `mobileHeaderControlFillClass` (the sidebar toggle's circle).
          !disabled && isOpen
            ? 'bg-secondary'
            : collapsed
              ? 'max-md:bg-muted/80 max-md:dark:bg-muted/40'
              : 'hover:bg-accent dark:hover:bg-secondary/50',
        )}
      >
        <Icon
          className={cn(
            // `max-w-none`: preflight gives <img> `max-width: 100%`, and when
            // the collapsed label track hits 0fr, WebKit/Firefox resolve that
            // cyclic percentage against the collapsed content box — computing
            // the logo's width to 0 (Chrome doesn't). Opt out entirely.
            'max-w-none text-muted-foreground shrink-0 transition-[width,height] duration-300',
            collapsed ? 'size-[var(--icon-size-default)]' : triggerAgent.type === 'built-in' ? 'size-4' : 'size-3.5',
          )}
        />
        {/* Muted like the mode/model picker labels — chrome, not content.
            The 1fr→0fr grid track is the CSS-only way to animate a width of
            `auto` to zero, so the collapse glides instead of snapping. */}
        <div
          className={cn(
            'grid min-w-0 overflow-hidden transition-[grid-template-columns,opacity,padding] duration-300',
            collapsed ? 'grid-cols-[0fr] pl-0 opacity-0' : 'grid-cols-[1fr] pl-2 opacity-100',
          )}
        >
          <span className="min-w-0 font-medium truncate text-muted-foreground">
            {selected?.label ?? selectedAgent.name}
          </span>
        </div>
        {/* Hidden on mobile: the menu opens as an animated card there, so the
            chevron affordance is redundant. */}
        <ChevronDown
          className={cn(
            'ml-2 size-3.5 text-muted-foreground transition-transform shrink-0 max-md:hidden',
            !disabled && isOpen && 'rotate-180',
          )}
        />
      </div>
    )

    if (!disabled) {
      return triggerInner
    }

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{triggerInner}</TooltipTrigger>
          <TooltipContent side="bottom">Cannot change agent during reply</TooltipContent>
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
