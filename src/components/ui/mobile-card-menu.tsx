/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, CSSProperties, ReactNode } from 'react'

import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '@/components/ui/drawer'
import { cn } from '@/lib/utils'

export type MobileCardMenuSide = 'top' | 'bottom'

/** Touch-height action row rendered inside a `MobileCardMenu` list — sized at
 *  `--touch-height-default` (44px on mobile) for comfortable tapping. */
export const mobileCardMenuItemClass =
  'flex min-h-[var(--touch-height-default)] w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-[length:var(--font-size-body)] outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50'

type MobileCardMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: MobileCardMenuSide
  title: string
  children: ReactNode
  className?: string
  initialFocus?: ComponentProps<typeof DrawerContent>['initialFocus']
}

/** Floating mobile menu card with safe-area placement and directional entry. */
export const MobileCardMenu = ({
  open,
  onOpenChange,
  side = 'bottom',
  title,
  children,
  className,
  initialFocus,
}: MobileCardMenuProps) => {
  const safeAreaStyle: CSSProperties =
    side === 'top'
      ? { paddingTop: 'var(--safe-area-top-padding, 0px)' }
      : ({
          '--mobile-card-menu-bottom-padding':
            'max(var(--safe-area-bottom-padding, 0px) - var(--drawer-effective-keyboard-inset, 0px), 0px)',
        } as CSSProperties)

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection={side === 'top' ? 'up' : 'down'}>
      <DrawerContent
        initialFocus={initialFocus}
        className={cn(side === 'bottom' && 'pb-[var(--mobile-card-menu-bottom-padding)]', className)}
        style={safeAreaStyle}
      >
        {side === 'bottom' && <DrawerHandle className="mb-1 mt-2" />}
        <div className="shrink-0 px-4 pb-2 pt-2">
          <DrawerTitle className="text-[length:var(--font-size-sm)] text-muted-foreground">{title}</DrawerTitle>
        </div>
        {/* Flex column so a child's `min-h-0` + `overflow-y-auto` region is
            actually bounded — the drawer shrinks under the software keyboard
            (max-h minus the keyboard inset) and content must scroll, not clip. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        {side === 'top' && <DrawerHandle className="mb-2 mt-1" />}
      </DrawerContent>
    </Drawer>
  )
}
