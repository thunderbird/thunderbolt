/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarCloseButton } from '@/components/ui/sidebar-close-button'
import { useMacWindowControlsClearance } from '@/hooks/use-window-controls-safe-area'
import { isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { type ReactNode } from 'react'

type ContentViewHeaderProps = {
  title: string
  onClose: () => void
  actions?: ReactNode
  className?: string
}

/**
 * Reusable header component for content views
 * Provides consistent layout with title, optional actions, and close button
 */
export const ContentViewHeader = ({ title, onClose, actions, className = '' }: ContentViewHeaderProps) => {
  // At mobile width the content view fills the whole window, putting this
  // header's top-left under the macOS traffic lights — start the title to
  // their right (pl-24: the lights end at ~x=68, plus breathing room).
  const needsWindowControlsClearance = useMacWindowControlsClearance()
  // In the desktop app this header can be the topmost strip of the window
  // (full-window panel at mobile width), so it doubles as the drag surface —
  // same as every other header strip. Children (title, buttons) still receive
  // clicks; only the empty area initiates a drag.
  const dragProps = isTauriDesktop() ? { 'data-tauri-drag-region': true } : {}

  return (
    <div
      {...dragProps}
      className={cn(
        'flex h-12 w-full items-center justify-between pl-4 pr-2 flex-shrink-0',
        needsWindowControlsClearance && 'pl-24',
        className,
      )}
    >
      <h2 className="text-lg font-semibold truncate">{title}</h2>
      <div className="flex items-center gap-2">
        {actions}
        <SidebarCloseButton onClick={onClose} />
      </div>
    </div>
  )
}
