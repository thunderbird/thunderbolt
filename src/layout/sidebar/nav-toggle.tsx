/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import { m, useReducedMotion } from 'framer-motion'
import { CheckSquare, MessageCircle, Settings, type LucideIcon } from 'lucide-react'
import type { SidebarSection } from './types'

type SectionDefinition = {
  id: SidebarSection
  label: string
  icon: LucideIcon
}

const allSections: SectionDefinition[] = [
  { id: 'chats', label: 'Chats', icon: MessageCircle },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'settings', label: 'Settings', icon: Settings },
]

/** Near-critically-damped spring so the thumb glides to its slot without overshoot. */
const thumbSpring = { type: 'spring', stiffness: 500, damping: 40 } as const

type SidebarNavToggleProps = {
  activeSection: SidebarSection
  showTasks: boolean
  onSectionChange: (section: SidebarSection) => void
  /** Vertical stack for the collapsed desktop icon rail. */
  vertical?: boolean
}

/**
 * Segmented pill toggle that switches the sidebar between the Chats, Tasks
 * (feature-gated) and Settings sections. Icon-only segments; the selected
 * state is a raised thumb that slides between segments (shared `layoutId`).
 *
 * Purely presentational: the expanded sidebar centers the horizontal pill in
 * its header, while the collapsed desktop rail mounts a `vertical` instance
 * in the content area. Only one orientation mounts at a time, so the thumb
 * keeps its `layoutId` and animates across the collapse/expand transition.
 */
export const SidebarNavToggle = ({ activeSection, showTasks, onSectionChange, vertical }: SidebarNavToggleProps) => {
  const { triggerSelection } = useHaptics()
  const reducedMotion = useReducedMotion()

  const sections = allSections.filter((section) => section.id !== 'tasks' || showTasks)

  const handleSelect = (section: SidebarSection) => {
    if (section === activeSection) {
      return
    }
    triggerSelection()
    onSectionChange(section)
  }

  const renderSegment = ({ id, label, icon: Icon }: SectionDefinition) => {
    const isActive = id === activeSection
    return (
      <button
        key={id}
        type="button"
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => handleSelect(id)}
        className={cn(
          // The after: pseudo-element pads the hit area ~4px beyond the pill's
          // top/bottom so mobile segments (34px visible) meet --min-touch-height.
          'relative flex cursor-pointer items-center justify-center rounded-full outline-hidden ring-sidebar-ring transition-colors focus-visible:ring-2 after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""]',
          vertical ? 'size-7' : 'h-full w-[var(--touch-height-lg)]',
          isActive ? 'text-sidebar-accent-foreground' : 'text-muted-foreground hover:text-sidebar-foreground',
        )}
      >
        {isActive && (
          <m.span
            layoutId="sidebar-nav-thumb"
            transition={reducedMotion ? { duration: 0 } : thumbSpring}
            className="absolute inset-0 rounded-full border border-sidebar-border bg-sidebar shadow-sm dark:border-transparent"
          />
        )}
        <Icon className="relative size-[var(--icon-size-default)]" />
      </button>
    )
  }

  if (vertical) {
    // Sized to the rail's 32px square buttons (28px segment + 1px padding +
    // 1px border per side). -mt-2 cancels the group's top padding; mb-2 pads
    // the space below to match the 16px above the pill (header row + gap).
    return (
      <nav aria-label="Sidebar sections" className="-mt-2 mb-2 flex justify-center">
        <div className="flex w-fit flex-col items-center rounded-full border border-sidebar-border bg-sidebar-accent p-px dark:border-transparent">
          {sections.map(renderSegment)}
        </div>
      </nav>
    )
  }

  return (
    <nav aria-label="Sidebar sections">
      {/* Same height as the header's sidebar-toggle button so the row reads as one line. */}
      <div className="flex h-[var(--touch-height-sm)] w-fit items-center rounded-full border border-sidebar-border bg-sidebar-accent p-0.5 dark:border-transparent">
        {sections.map(renderSegment)}
      </div>
    </nav>
  )
}
