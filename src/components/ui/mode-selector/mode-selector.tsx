/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { cn } from '@/lib/utils'
import type { Mode } from '@/types'
import { Globe, MessageSquare, Microscope } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useMemo, type ReactNode } from 'react'

export type ModeSelectorProps = {
  modes: Mode[]
  selectedMode: Mode | null
  onModeChange: (modeId: string) => void
  iconOnly?: boolean
}

const iconMap: Record<string, ReactNode> = {
  'message-square': <MessageSquare className="size-[var(--icon-size-default)]" />,
  globe: <Globe className="size-[var(--icon-size-default)]" />,
  microscope: <Microscope className="size-[var(--icon-size-default)]" />,
}

const getModeIcon = (iconName: string): ReactNode => {
  return iconMap[iconName] ?? <MessageSquare className="size-[var(--icon-size-default)]" />
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

export const ModeSelector = ({ modes, selectedMode, onModeChange, iconOnly = false }: ModeSelectorProps) => {
  const { isMobile } = useIsMobile()
  const groupedItems = useMemo(() => createModeGroups(modes), [modes])

  const renderTrigger = (selected: SearchableMenuItem<ModeItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center rounded-lg cursor-pointer transition-colors text-[length:var(--font-size-body)] border border-border',
        iconOnly ? 'size-[var(--touch-height-sm)] justify-center' : 'gap-2 px-3 h-[var(--touch-height-default)]',
        isOpen ? 'bg-accent' : 'hover:bg-accent/50',
      )}
    >
      {selected?.icon ?? <MessageSquare className="size-[var(--icon-size-default)]" />}
      {!iconOnly && <span className="font-medium text-muted-foreground">{selected?.label ?? 'Chat'}</span>}
    </div>
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
        {item.icon}
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
