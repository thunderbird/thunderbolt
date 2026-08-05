/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Slot } from '@radix-ui/react-slot'
import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { MobileCardMenu } from '@/components/ui/mobile-card-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/use-mobile'

type ResponsivePopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Single trigger element. Wired to the popover on desktop; on mobile it
   * receives `aria-haspopup`/`aria-expanded` and (by default) click-to-open.
   */
  trigger: ReactElement
  /** Accessible heading shown on the mobile drawer card. */
  title: string
  children: ReactNode
  /**
   * Set false when the trigger's click has its own job and the menu opens
   * some other way (e.g. a chip that inserts on click, opens on long-press).
   */
  openOnTriggerClickMobile?: boolean
  /** Placement/styling for the mobile drawer card. */
  mobileMenu?: Pick<ComponentProps<typeof MobileCardMenu>, 'side' | 'className' | 'initialFocus'>
  /** Positioning/sizing for the desktop popover panel. */
  desktopMenu?: Pick<
    ComponentProps<typeof PopoverContent>,
    'side' | 'align' | 'sideOffset' | 'collisionPadding' | 'className' | 'style' | 'onOpenAutoFocus'
  >
}

/**
 * Arbitrary popover content that renders as a `MobileCardMenu` drawer on
 * mobile and a `Popover` on desktop. Owns the two-way viewport branch and the
 * trigger wiring, so consumers only supply a trigger and the panel content.
 * For simple action lists prefer `ResponsiveActionMenu`, which layers the
 * shared row markup on the same idea.
 */
export const ResponsivePopover = ({
  open,
  onOpenChange,
  trigger,
  title,
  children,
  openOnTriggerClickMobile = true,
  mobileMenu,
  desktopMenu,
}: ResponsivePopoverProps) => {
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
        <MobileCardMenu open={open} onOpenChange={onOpenChange} title={title} {...mobileMenu}>
          {children}
        </MobileCardMenu>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent {...desktopMenu}>{children}</PopoverContent>
    </Popover>
  )
}
