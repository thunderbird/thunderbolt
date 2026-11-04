/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useRef, type ReactNode } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { DetailPanelSurface } from './detail-panel'

/** Stack a child form inside its parent aside, retaining the parent's draft and width. */
export const DetailPanelOverlay = ({
  title,
  open,
  onClose,
  children,
}: {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
}) => {
  const { isMobile } = useIsMobile()
  const returnFocus = useRef<HTMLElement | null>(null)

  if (isMobile) {
    return (
      <DetailPanelSurface open={open} onClose={onClose}>
        {children}
      </DetailPanelSurface>
    )
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className="absolute inset-0 z-20 flex flex-col bg-sidebar outline-none"
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocus.current?.focus()
        }}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  )
}
