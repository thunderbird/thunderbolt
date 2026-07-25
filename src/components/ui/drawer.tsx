/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps } from 'react'
import { Drawer as DrawerPrimitive } from 'vaul'

import { cn } from '@/lib/utils'
import { modalOverlayClass } from '@/components/ui/modal-styles'

const Drawer = ({ shouldScaleBackground = false, ...props }: ComponentProps<typeof DrawerPrimitive.Root>) => (
  <DrawerPrimitive.Root data-slot="drawer" shouldScaleBackground={shouldScaleBackground} {...props} />
)

const DrawerPortal = (props: ComponentProps<typeof DrawerPrimitive.Portal>) => (
  <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
)

const DrawerOverlay = ({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Overlay>) => (
  <DrawerPrimitive.Overlay
    data-slot="drawer-overlay"
    className={cn(
      modalOverlayClass,
      'z-40 bg-black/30 backdrop-blur-sm max-md:backdrop-blur-sm max-md:backdrop-saturate-75',
      className,
    )}
    {...props}
  />
)

const DrawerContent = ({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Content>) => (
  <DrawerPortal>
    <DrawerOverlay />
    <DrawerPrimitive.Content
      data-slot="drawer-content"
      className={cn(
        'group/drawer-content fixed z-50 flex h-auto max-h-[85dvh] w-full flex-col bg-popover/80 text-popover-foreground shadow-2xl outline-none backdrop-blur-lg',
        'data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:rounded-b-3xl data-[vaul-drawer-direction=top]:border-b',
        'data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:rounded-t-3xl data-[vaul-drawer-direction=bottom]:border-t',
        className,
      )}
      {...props}
    />
  </DrawerPortal>
)

const DrawerHandle = ({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Handle>) => (
  <DrawerPrimitive.Handle
    data-slot="drawer-handle"
    className={cn(
      'mx-auto !h-1 !w-10 shrink-0 rounded-full !bg-muted-foreground/10 !opacity-100 dark:!bg-white/5',
      className,
    )}
    {...props}
  />
)

const DrawerTitle = ({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Title>) => (
  <DrawerPrimitive.Title
    data-slot="drawer-title"
    className={cn('font-semibold text-foreground', className)}
    {...props}
  />
)

const DrawerDescription = ({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Description>) => (
  <DrawerPrimitive.Description
    data-slot="drawer-description"
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
)

export { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle }
