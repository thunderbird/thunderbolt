import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { cn } from '@/lib/utils'
import type { Mode } from '@/types'
import { Globe, MessageSquare, Microscope } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'

export type ModeSelectorProps = {
  modes: Mode[]
  selectedMode: Mode | null
  onModeChange: (modeId: string) => void
}

const iconMap: Record<string, ReactNode> = {
  'message-square': <MessageSquare className="size-4" />,
  globe: <Globe className="size-4" />,
  microscope: <Microscope className="size-4" />,
}

const getModeIcon = (iconName: string): ReactNode => {
  return iconMap[iconName] ?? <MessageSquare className="size-4" />
}

type ModeItemData = {
  mode: Mode
}

const createModeGroups = (modes: Mode[]): SearchableMenuGroup<ModeItemData>[] => [
  {
    id: 'mode',
    label: '',
    items: modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      icon: getModeIcon(mode.icon),
      data: { mode },
    })),
  },
]

export const ModeSelector = ({ modes, selectedMode, onModeChange }: ModeSelectorProps) => {
  const groupedItems = useMemo(() => createModeGroups(modes), [modes])

  const renderTrigger = (selected: SearchableMenuItem<ModeItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-sm border border-border',
        isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      {selected?.icon ?? <MessageSquare className="size-4" />}
      <span className="font-medium text-muted-foreground">{selected?.label ?? 'Chat'}</span>
    </div>
  )

  const renderItem = (item: SearchableMenuItem<ModeItemData>, isSelected: boolean) => {
    const isDefault = item.data?.mode.isDefault === 1

    return (
      <div
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2.5 mt-1.5 rounded-xl transition-colors text-left cursor-pointer',
          isSelected ? 'bg-muted' : 'hover:bg-accent/50',
        )}
      >
        {item.icon}
        <span>{item.label}</span>
        {isDefault && <span className="text-muted-foreground text-sm">Default</span>}
      </div>
    )
  }

  return (
    <SearchableMenu
      items={groupedItems}
      value={selectedMode?.id}
      onValueChange={onModeChange}
      searchable={false}
      blurBackdrop
      side="top"
      align="start"
      trigger={renderTrigger}
      renderItem={renderItem}
      width={280}
      maxHeight={300}
      contentClassName="rounded-2xl shadow-lg overflow-hidden"
    />
  )
}
