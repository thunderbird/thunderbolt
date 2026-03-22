import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types'
import { Check, ChevronDown, Code, Globe, Terminal, Zap } from 'lucide-react'
import { useCallback, useMemo } from 'react'

export type AgentSelectorProps = {
  agents: Agent[]
  selectedAgent: Agent | null
  onAgentChange: (agentId: string) => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

type AgentItemData = {
  agent: Agent
}

const agentIcons: Record<string, typeof Zap> = {
  zap: Zap,
  terminal: Terminal,
  code: Code,
  globe: Globe,
}

const getAgentIcon = (iconName: string | null) => {
  const Icon = agentIcons[iconName ?? 'zap'] ?? Zap
  return <Icon className="size-3.5 text-muted-foreground" />
}

const toMenuItem = (agent: Agent, isDisabled: boolean): SearchableMenuItem<AgentItemData> => ({
  id: agent.id,
  label: agent.name,
  description: agent.type === 'built-in' ? 'Built-in' : agent.type === 'local' ? 'Local' : 'Remote',
  icon: getAgentIcon(agent.icon),
  disabled: isDisabled,
  data: { agent },
})

export const categorizeAgents = (agents: Agent[]): SearchableMenuGroup<AgentItemData>[] => {
  const builtIn: SearchableMenuItem<AgentItemData>[] = []
  const local: SearchableMenuItem<AgentItemData>[] = []
  const remote: SearchableMenuItem<AgentItemData>[] = []

  for (const agent of agents) {
    const item = toMenuItem(agent, false)

    switch (agent.type) {
      case 'built-in':
        builtIn.push(item)
        break
      case 'local':
        local.push(item)
        break
      case 'remote':
        remote.push(item)
        break
    }
  }

  const groups: SearchableMenuGroup<AgentItemData>[] = []

  if (builtIn.length > 0) {
    groups.push({ id: 'built-in', items: builtIn })
  }
  if (local.length > 0) {
    groups.push({ id: 'local', label: 'Local Agents', items: local })
  }
  if (remote.length > 0) {
    groups.push({ id: 'remote', label: 'Remote Agents', items: remote })
  }

  return groups
}

export const AgentSelector = ({ agents, selectedAgent, onAgentChange, side, align }: AgentSelectorProps) => {
  const groupedItems = useMemo(() => categorizeAgents(agents), [agents])

  const renderTrigger = (selected: SearchableMenuItem<AgentItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center gap-2 px-3 h-[var(--touch-height-sm)] rounded-full cursor-pointer transition-colors text-[length:var(--font-size-body)]',
        isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      {selected?.icon}
      <span className="font-medium">{selected?.label ?? 'Select Agent'}</span>
      <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
    </div>
  )

  const renderItem = (item: SearchableMenuItem<AgentItemData>, isSelected: boolean) => (
    <div
      className={cn(
        'w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors text-left cursor-pointer',
        'hover:bg-accent/50',
        isSelected && 'bg-accent',
        item.disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {item.icon}
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-medium truncate">{item.label}</span>
          <span className="text-sm text-muted-foreground truncate">{item.description}</span>
        </div>
      </div>
      {isSelected && <Check className="size-4 text-foreground flex-shrink-0" />}
    </div>
  )

  const { triggerSelection } = useHaptics()
  const handleAgentChange = useCallback(
    (id: string) => {
      triggerSelection()
      onAgentChange(id)
    },
    [onAgentChange, triggerSelection],
  )

  return (
    <SearchableMenu
      items={groupedItems}
      value={selectedAgent?.id}
      onValueChange={handleAgentChange}
      searchable={agents.length > 10}
      searchPlaceholder="Search Agents"
      emptyMessage="No agents found"
      blurBackdrop
      trigger={renderTrigger}
      renderItem={renderItem}
      width={320}
      maxHeight={340}
      side={side}
      align={align}
    />
  )
}
