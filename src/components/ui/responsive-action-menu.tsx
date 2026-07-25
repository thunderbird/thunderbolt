/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Slot } from '@radix-ui/react-slot'
import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MobileCardMenu, mobileCardMenuItemClass } from '@/components/ui/mobile-card-menu'
import { useIsMobile } from '@/hooks/use-mobile'

export type ResponsiveActionMenuAction = {
  label: string
  icon: ReactNode
  onSelect: () => void
}

type ResponsiveActionMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Single trigger element. Wired to the dropdown on desktop; on mobile it
   * receives `aria-haspopup`/`aria-expanded` and (by default) click-to-open.
   */
  trigger: ReactElement
  /** Accessible heading shown on the mobile card menu. */
  title: string
  actions: ResponsiveActionMenuAction[]
  /**
   * Set false when the trigger's click has its own job and the menu opens
   * some other way (e.g. the skill chip inserts on click, opens on
   * long-press).
   */
  openOnTriggerClickMobile?: boolean
  /** Positioning/sizing for the desktop dropdown panel. */
  desktopMenu?: Pick<
    ComponentProps<typeof DropdownMenuContent>,
    'side' | 'align' | 'sideOffset' | 'collisionPadding' | 'className'
  >
}

/**
 * An action menu that renders as a `MobileCardMenu` drawer on mobile and a
 * `DropdownMenu` on desktop, from one `actions` array. Owns the two-way
 * viewport branch, the touch-row markup, and closing the menu before an
 * action runs, so consumers only supply a trigger and their actions.
 */
export const ResponsiveActionMenu = ({
  open,
  onOpenChange,
  trigger,
  title,
  actions,
  openOnTriggerClickMobile = true,
  desktopMenu,
}: ResponsiveActionMenuProps) => {
  const { isMobile } = useIsMobile()

  if (isMobile) {
    return (
      <>
        <Slot
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openOnTriggerClickMobile ? () => onOpenChange(!open) : undefined}
        >
          {trigger}
        </Slot>
        <MobileCardMenu open={open} onOpenChange={onOpenChange} title={title}>
          <div className="flex flex-col gap-0.5 px-1 pb-1">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={mobileCardMenuItemClass}
                onClick={() => {
                  onOpenChange(false)
                  action.onSelect()
                }}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        </MobileCardMenu>
      </>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent {...desktopMenu}>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onSelect={action.onSelect}
            className="min-h-[var(--min-touch-height)] cursor-pointer"
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
