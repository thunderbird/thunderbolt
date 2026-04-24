import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { SelectorTrigger } from '@/components/ui/selector-trigger'
import { cn } from '@/lib/utils'
import type { Mode } from '@/types'
import { Sparkles } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useMemo } from 'react'

export type ModeSelectorProps = {
  modes: Mode[]
  selectedMode: Mode | null
  onModeChange: (modeId: string) => void
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
      data: { mode },
    })),
  },
]

export const ModeSelector = ({ modes, selectedMode, onModeChange }: ModeSelectorProps) => {
  const { isMobile } = useIsMobile()
  const groupedItems = useMemo(() => createModeGroups(modes), [modes])

  const renderTrigger = (selected: SearchableMenuItem<ModeItemData> | undefined, isOpen: boolean) => (
    <SelectorTrigger
      icon={<Sparkles className="size-[var(--icon-size-default)] shrink-0" />}
      label={selected?.label ?? 'Chat'}
      isOpen={isOpen}
    />
  )

  const renderItem = (item: SearchableMenuItem<ModeItemData>, isSelected: boolean) => {
    const isDefault = item.data?.mode.isDefault === 1

    return (
      <div
        className={cn(
          'w-full flex items-center gap-2 px-3 py-3 md:py-2 rounded-lg transition-colors text-left cursor-pointer',
          isSelected ? 'bg-accent' : 'hover:bg-accent/50',
        )}
      >
        <span>{item.label}</span>
        {isDefault && <span className="text-muted-foreground text-[length:var(--font-size-sm)]">Default</span>}
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
      side={isMobile ? 'top' : 'bottom'}
      align="start"
      trigger={renderTrigger}
      renderItem={renderItem}
      width={280}
      maxHeight={300}
    />
  )
}
