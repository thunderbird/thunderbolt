/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { type ComponentProps } from 'react'

import { cn } from '@/lib/utils'

const ContextMenu = ({ ...props }: ComponentProps<typeof ContextMenuPrimitive.Root>) => {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

const ContextMenuTrigger = ({ ...props }: ComponentProps<typeof ContextMenuPrimitive.Trigger>) => {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

const ContextMenuPortal = ({ ...props }: ComponentProps<typeof ContextMenuPrimitive.Portal>) => {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

const ContextMenuContent = ({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Content>) => {
  return (
    <ContextMenuPortal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 min-w-56 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-xl border border-border-strong p-2 shadow-md',
          className,
        )}
        {...props}
      />
    </ContextMenuPortal>
  )
}

const ContextMenuItem = ({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Item>) => {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        "relative flex h-9 cursor-pointer items-center gap-1.5 rounded-xl px-2 text-sm whitespace-nowrap outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

const ContextMenuSeparator = ({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Separator>) => {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('bg-border my-1 h-px', className)}
      {...props}
    />
  )
}

export { ContextMenu, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem, ContextMenuSeparator }
