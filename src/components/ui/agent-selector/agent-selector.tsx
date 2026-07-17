/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SearchableMenu, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'
import { ChevronDown, Globe, Plus, Server, Zap } from 'lucide-react'
import { useMemo, useState, type ComponentType } from 'react'

export type AgentSelectorProps = {
  selectedAgent: Agent
  agents: Agent[]
  onSelect: (agent: Agent) => void
  onAddAgent?: () => void
  disabled?: boolean
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

type AgentItemData = {
  agent: Agent
}

/** Visual icon for each agent flavor. Mirrors `agent-row.tsx` so list + selector
 *  stay perceptually consistent across Settings and the chat header. */
const iconForAgent = (agent: Agent): ComponentType<{ className?: string }> => {
  if (agent.type === 'built-in') {
    return Zap
  }
  if (agent.isSystem === 1) {
    return Server
  }
  return Globe
}

const toMenuItem = (agent: Agent): SearchableMenuItem<AgentItemData> => {
  const Icon = iconForAgent(agent)
  return {
    id: agent.id,
    label: agent.name,
    icon: <Icon className="size-3.5 text-muted-foreground" />,
    data: { agent },
  }
}

/** Compact item renderer — label-only rows (no descriptions) pinned to 14px
 *  (`--font-size-body`) so the menu stays tight. */
const renderAgentItem = (item: SearchableMenuItem<AgentItemData>, isSelected: boolean) => (
  <div
    className={cn(
      'w-full flex items-center gap-2 px-3 h-[var(--touch-height-sm)] rounded-lg transition-colors text-left cursor-pointer text-[length:var(--font-size-body)]',
      isSelected ? 'bg-accent' : 'hover:bg-accent/50',
    )}
  >
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
    const Icon = iconForAgent(selected?.data?.agent ?? selectedAgent)
    const triggerInner = (
      <div
        data-testid="agent-selector-trigger"
        aria-disabled={disabled}
        className={cn(
          'flex items-center gap-2 px-3 h-[var(--touch-height-sm)] rounded-full transition-colors text-[length:var(--font-size-body)] max-w-[50vw] md:max-w-none',
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
          // Light secondary is nearly the same shade as the page background,
          // so at 50% the hover reads as invisible — use full accent there
          // (same hover as the header's ghost buttons). Dark keeps the
          // subtler half-secondary.
          !disabled && isOpen ? 'bg-secondary' : 'hover:bg-accent dark:hover:bg-secondary/50',
        )}
      >
        <Icon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium truncate">{selected?.label ?? selectedAgent.name}</span>
        <ChevronDown
          className={cn(
            'size-3.5 text-muted-foreground transition-transform shrink-0',
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
      // Negative margins cancel the shared footer's px-2 py-2 so the row is a
      // flush, 36px-tall, full-width item (hover fills edge to edge).
      className="-m-2 flex h-[var(--touch-height-default)] w-[calc(100%_+_1rem)] cursor-pointer items-center justify-start gap-2 px-4 text-[length:var(--font-size-body)] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
      blurBackdrop
      trigger={renderTrigger}
      renderItem={renderAgentItem}
      itemGap="gap-0.5"
      footer={footer}
      width={320}
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
