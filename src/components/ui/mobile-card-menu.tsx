/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, ReactNode } from 'react'

import { Drawer, DrawerContent, DrawerHandle, DrawerTitle } from '@/components/ui/drawer'
import { cn } from '@/lib/utils'

export type MobileCardMenuSide = 'top' | 'bottom'

/** Touch-height action row rendered inside a `MobileCardMenu` list. */
export const mobileCardMenuItemClass =
  'flex min-h-[var(--min-touch-height)] w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-[length:var(--font-size-body)] outline-none transition-colors hover:bg-accent focus-visible:bg-accent'

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
  const safeAreaStyle =
    side === 'top'
      ? { paddingTop: 'var(--safe-area-top-padding, 0px)' }
      : { paddingBottom: 'var(--safe-area-bottom-padding, 0px)' }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection={side === 'top' ? 'up' : 'down'}>
      <DrawerContent initialFocus={initialFocus} className={cn('overflow-hidden', className)} style={safeAreaStyle}>
        {side === 'bottom' && <DrawerHandle className="mb-1 mt-2" />}
        <div className="shrink-0 px-4 pb-2 pt-2">
          <DrawerTitle className="text-[length:var(--font-size-sm)] text-muted-foreground">{title}</DrawerTitle>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {side === 'top' && <DrawerHandle className="mb-2 mt-1" />}
      </DrawerContent>
    </Drawer>
  )
}
