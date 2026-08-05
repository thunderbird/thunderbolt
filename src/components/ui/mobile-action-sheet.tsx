/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, ReactNode } from 'react'

import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from '@/components/ui/drawer'
import { modalFieldSurfaceClass } from '@/components/ui/modal-styles'
import { cn } from '@/lib/utils'

type MobileActionSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  initialFocus?: ComponentProps<typeof DrawerContent>['initialFocus']
  role?: 'dialog' | 'alertdialog'
}

/**
 * Bottom sheet for compact mobile prompts and confirmations.
 * It follows the software keyboard and preserves dialog semantics.
 */
export const MobileActionSheet = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  initialFocus,
  role = 'dialog',
}: MobileActionSheetProps) => (
  <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="down">
    <DrawerContent forceBackdrop initialFocus={initialFocus} role={role} className={modalFieldSurfaceClass}>
      <DrawerHandle className="mb-1 mt-2" />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-[var(--modal-footer-inset)] pt-2">
        <div className="flex shrink-0 flex-col gap-2">
          <DrawerTitle className="text-lg leading-none">{title}</DrawerTitle>
          {description && (
            <DrawerDescription className="text-[length:var(--font-size-sm)]">{description}</DrawerDescription>
          )}
        </div>
        {children}
      </div>
    </DrawerContent>
  </Drawer>
)

/** Stacks sheet actions with the safest action closest to the bottom edge. */
export const MobileActionSheetFooter = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('flex shrink-0 flex-col-reverse gap-2', className)} {...props} />
)
