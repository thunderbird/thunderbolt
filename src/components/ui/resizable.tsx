/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GripVerticalIcon } from 'lucide-react'
import { type ComponentProps } from 'react'
import * as ResizablePrimitive from 'react-resizable-panels'

import { cn } from '@/lib/utils'

// Disable global cursor styles to prevent cursor overlap issues with webviews
// and other content. We'll manage cursor styles manually on the resize handle.
ResizablePrimitive.disableGlobalCursorStyles()

const ResizablePanelGroup = ({ className, ...props }: ComponentProps<typeof ResizablePrimitive.PanelGroup>) => {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full data-[panel-group-direction=vertical]:flex-col', className)}
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
  ...props
}: ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) => {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        'bg-border focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-[calc(50%-2px)] after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:top-[calc(50%-2px)] data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 [&[data-panel-group-direction=vertical]>div]:rotate-90',
        // Manually apply cursor styles since we disabled global cursor styles
        'cursor-ew-resize data-[panel-group-direction=vertical]:cursor-ns-resize',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
