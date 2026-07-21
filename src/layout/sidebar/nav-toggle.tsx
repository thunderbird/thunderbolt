/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import { m, useReducedMotion } from 'framer-motion'
import { MessageCircle, Settings, type LucideIcon } from 'lucide-react'
import type { SidebarSection } from './types'

type SectionDefinition = {
  id: SidebarSection
  label: string
  icon: LucideIcon
}

const sections: SectionDefinition[] = [
  { id: 'chats', label: 'Chats', icon: MessageCircle },
  { id: 'settings', label: 'Settings', icon: Settings },
]

/** Near-critically-damped spring so the thumb glides to its slot without overshoot. */
const thumbSpring = { type: 'spring', stiffness: 500, damping: 40 } as const

type SidebarNavToggleProps = {
  activeSection: SidebarSection
  onSectionChange: (section: SidebarSection) => void
  /** Vertical stack for the collapsed desktop icon rail. */
  vertical?: boolean
}

/**
 * Segmented toggle that switches the sidebar between the Chats and Settings
 * sections. Icon-only segments on the bare sidebar surface; the selected
 * state is a soft accent square (rounded-xl, matching the New Chat menu
 * button) that slides between segments (shared `layoutId`).
 *
 * Purely presentational: the expanded sidebar centers the horizontal pill in
 * its header, while the collapsed desktop rail mounts a `vertical` instance
 * in the content area. Only one orientation mounts at a time, so the thumb
 * keeps its `layoutId` and animates across the collapse/expand transition.
 */
export const SidebarNavToggle = ({ activeSection, onSectionChange, vertical }: SidebarNavToggleProps) => {
  const { triggerSelection } = useHaptics()
  const reducedMotion = useReducedMotion()

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
          // The after: pseudo-element pads the hit area ~4px beyond the
          // segment's top/bottom so the compact segments (28px in the vertical
          // rail) stay comfortable to hit and mobile meets --min-touch-height.
          'relative flex cursor-pointer items-center justify-center rounded-xl outline-hidden ring-sidebar-ring transition-colors focus-visible:ring-2 after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""]',
          vertical ? 'size-8' : 'h-full aspect-square',
          isActive ? 'text-sidebar-accent-foreground' : 'text-muted-foreground hover:text-sidebar-foreground',
        )}
      >
        {isActive && (
          // No insets: the abspos thumb sits at its static position, which the
          // button's flex centering resolves to dead center; h-full +
          // aspect-square keeps it square in both orientations. rounded-xl
          // matches the New Chat menu button's radius.
          <m.span
            layoutId="sidebar-nav-thumb"
            transition={reducedMotion ? { duration: 0 } : thumbSpring}
            className="absolute h-full aspect-square rounded-xl bg-sidebar-accent"
          />
        )}
        {/* z-10 keeps both icons above the sliding thumb: the thumb mounts
            inside the newly-active segment, and when that segment is a later
            DOM sibling it would otherwise paint over the other icon mid-slide. */}
        <Icon className="relative z-10 size-[var(--icon-size-default)]" />
      </button>
    )
  }

  if (vertical) {
    // Segments match the rail's 32px square buttons (size-8) so the active
    // thumb reads as the same control as the rail items below. -mt-2 cancels
    // the group's top padding; mb-2 pads the space below to match the 16px
    // above the pill (header row + gap).
    return (
      <nav aria-label="Sidebar sections" className="-mt-2 mb-2 flex justify-center">
        <div className="flex w-fit flex-col items-center">{sections.map(renderSegment)}</div>
      </nav>
    )
  }

  return (
    <nav aria-label="Sidebar sections">
      {/* Same height as the footer's New Chat / theme / account controls so
          the row reads as one line. Mobile is full-bleed so the thumb's
          diameter matches those controls exactly (44px); desktop keeps a 2px
          inset for a more compact thumb in the header. Square segments +
          gap-0.5 mirror the ChatActions search/clear-all pair, so both icon
          duos sit the same distance apart. */}
      <div className="flex h-[var(--touch-height-default)] w-fit items-center gap-0.5 md:p-0.5">
        {sections.map(renderSegment)}
      </div>
    </nav>
  )
}
