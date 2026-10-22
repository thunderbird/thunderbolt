/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronRight } from 'lucide-react'
import { flushSync } from 'react-dom'
import { MobileCardMenu, mobileCardMenuItemClass } from '@/components/ui/mobile-card-menu'
import type { ResponsiveActionMenuAction } from '@/components/ui/responsive-action-menu'
import { SidebarGroupLabel } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { useSidebarSectionToggleState } from './use-sidebar-section-toggle-state'

/** A disclosure control that keeps the sidebar section label's typography. */
export const SidebarSectionToggle = ({
  expanded,
  onToggle,
  controls,
  label,
  mobileAction,
}: {
  expanded: boolean
  onToggle: () => void
  controls: string
  label: string
  mobileAction?: ResponsiveActionMenuAction
}) => {
  const { menuOpen, setMenuOpen, longPressHandlers, handleClick, handleKeyDown } =
    useSidebarSectionToggleState(onToggle)

  return (
    <>
      <SidebarGroupLabel asChild className="min-w-0 flex-1 cursor-pointer gap-1.5 text-left">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={controls}
          aria-haspopup={mobileAction ? 'dialog' : undefined}
          data-long-press={mobileAction ? '' : undefined}
          {...(mobileAction ? longPressHandlers : {})}
          onClick={mobileAction ? handleClick : onToggle}
          onKeyDown={mobileAction ? handleKeyDown : undefined}
        >
          {label}
          <span aria-hidden="true">
            <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
          </span>
        </button>
      </SidebarGroupLabel>
      {mobileAction && (
        <MobileCardMenu open={menuOpen} onOpenChange={setMenuOpen} title={label}>
          <div className="px-1 pb-1">
            <button
              type="button"
              className={mobileCardMenuItemClass}
              disabled={mobileAction.disabled}
              onClick={() => {
                flushSync(() => setMenuOpen(false))
                mobileAction.onSelect()
              }}
            >
              {mobileAction.icon}
              {mobileAction.label}
            </button>
          </div>
        </MobileCardMenu>
      )}
    </>
  )
}
