/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GripVerticalIcon } from 'lucide-react'
import { type ComponentProps } from 'react'
import * as ResizablePrimitive from 'react-resizable-panels'

import { cn } from '@/lib/utils'

const ResizablePanelGroup = ({ className, ...props }: ComponentProps<typeof ResizablePrimitive.Group>) => {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      disableCursor
      className={cn('flex h-full w-full', className)}
      {...props}
    />
  )
}

const ResizablePanel = ({ className, ...props }: ComponentProps<typeof ResizablePrimitive.Panel>) => {
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      className={cn('transition-[flex-basis] duration-300 ease-in-out', className)}
      {...props}
    />
  )
}

const ResizableHandle = ({
  withHandle,
  className,
  handleClassName,
  children,
  ...props
}: ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean
  handleClassName?: string
}) => {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        'focus-visible:ring-ring group relative flex w-1 shrink-0 items-center justify-center after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden',
        'cursor-col-resize',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div
          data-slot="resizable-handle-grip"
          className={cn(
            'bg-border z-10 flex h-4 w-3 items-center justify-center rounded-sm border text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground group-data-[separator=active]:bg-muted group-data-[separator=active]:text-foreground',
            handleClassName,
          )}
        >
          <GripVerticalIcon aria-hidden="true" className="size-2.5" />
        </div>
      )}
      {children}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
