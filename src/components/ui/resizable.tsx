/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GripVerticalIcon } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { type ComponentProps, useEffect, useRef } from 'react'
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
  children,
  ...props
}: ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean
}) => {
  const { t } = useLingui()
  const elementRef = useRef<HTMLDivElement>(null)
  // react-resizable-panels fills in the separator's value only after a layout
  // change, so a freshly mounted handle has no aria-valuenow, which a focusable
  // separator requires (WCAG 4.1.2). Seed it from the leading panel's share of
  // the group until the library takes over on the first resize.
  useEffect(() => {
    const element = elementRef.current
    const panel = element?.previousElementSibling
    const group = element?.parentElement
    if (!element || !panel || !group || element.hasAttribute('aria-valuenow')) {
      return
    }
    const isVertical = element.getAttribute('aria-orientation') === 'horizontal'
    const groupRect = group.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const total = isVertical ? groupRect.height : groupRect.width
    if (total === 0) {
      return
    }
    const share = (isVertical ? panelRect.height : panelRect.width) / total
    element.setAttribute('aria-valuemin', '0')
    element.setAttribute('aria-valuemax', '100')
    element.setAttribute('aria-valuenow', String(Math.round(share * 100)))
  }, [])

  return (
    <ResizablePrimitive.Separator
      elementRef={elementRef}
      data-slot="resizable-handle"
      aria-label={t`Resize panels`}
      className={cn(
        'bg-border focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-[calc(50%-2px)] after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden',
        'cursor-ew-resize',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-sm border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
      {children}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
