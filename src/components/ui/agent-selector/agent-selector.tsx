/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
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
    description: agent.description ?? undefined,
    icon: <Icon className="size-3.5 text-muted-foreground" />,
    data: { agent },
  }
}

/** Bucket agents by flavor for the dropdown. Order mirrors `composeAllAgents`:
 *  Built-in → System → Custom. Empty buckets are dropped so the menu stays tight. */
export const categorizeAgents = (agents: Agent[]): SearchableMenuGroup<AgentItemData>[] => {
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

  const groups: SearchableMenuGroup<AgentItemData>[] = []
  if (builtIn.length > 0) {
    groups.push({ id: 'built-in', label: 'Built-in', items: builtIn })
  }
  if (system.length > 0) {
    groups.push({ id: 'system', label: 'System', items: system })
  }
  if (custom.length > 0) {
    groups.push({ id: 'custom', label: 'Custom', items: custom })
  }
  return groups
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
  const groupedItems = useMemo(() => categorizeAgents(agents), [agents])
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
          !disabled && isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
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
    <Button
      variant="ghost"
      onClick={() => {
        setOpen(false)
        onAddAgent()
      }}
      className="w-full justify-start gap-2 text-muted-foreground"
    >
      <Plus className="size-4" />
      Add Agent
    </Button>
  ) : undefined

  return (
    <SearchableMenu
      items={groupedItems}
      value={selectedAgent.id}
      onValueChange={handleAgentChange}
      searchable={agents.length > 10}
      searchPlaceholder="Search agents"
      emptyMessage="No agents found"
      blurBackdrop
      trigger={renderTrigger}
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
