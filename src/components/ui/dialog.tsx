/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { type ComponentProps } from 'react'

import { cn } from '@/lib/utils'
import { centeredModalSurfaceClass, modalAnimationClass, modalCloseClass, modalOverlayClass } from './modal-styles'

export const modalFieldSurfaceClass =
  '[&_[data-slot=input]]:!bg-card [&_[data-slot=textarea]]:!bg-card [&_[data-slot=select-trigger]]:!bg-card [&_[data-slot=combobox-trigger]]:!bg-card dark:[&_[data-slot=input]]:!bg-input dark:[&_[data-slot=textarea]]:!bg-input dark:[&_[data-slot=select-trigger]]:!bg-input dark:[&_[data-slot=combobox-trigger]]:!bg-input'

const Dialog = ({ ...props }: ComponentProps<typeof DialogPrimitive.Root>) => {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

const DialogTrigger = ({ ...props }: ComponentProps<typeof DialogPrimitive.Trigger>) => {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

const DialogPortal = ({ ...props }: ComponentProps<typeof DialogPrimitive.Portal>) => {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

const DialogClose = ({ ...props }: ComponentProps<typeof DialogPrimitive.Close>) => {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

const DialogOverlay = ({
  className,
  useTransparentOverlay = true,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay> & { useTransparentOverlay?: boolean }) => {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        useTransparentOverlay ? modalOverlayClass : `${modalAnimationClass} fixed inset-0 z-50 bg-background`,
        className,
      )}
      {...props}
    />
  )
}

const DialogContent = ({
  className,
  children,
  showCloseButton = true,
  useTransparentOverlay = true,
  fullScreen = false,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  useTransparentOverlay?: boolean
  fullScreen?: boolean
}) => {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay useTransparentOverlay={useTransparentOverlay} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'grid gap-4 p-6',
          modalFieldSurfaceClass,
          fullScreen
            ? `${modalAnimationClass} fixed top-0 left-0 z-50 w-full rounded-none border-0 bg-background shadow-none duration-200`
            : `${centeredModalSurfaceClass} sm:max-w-lg`,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={`${modalCloseClass} right-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`}
            style={{ top: fullScreen ? 'calc(var(--safe-area-top-padding, 0px) + 16px)' : '16px' }}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

const DialogHeader = ({ className, ...props }: ComponentProps<'div'>) => {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

const DialogFooter = ({ className, ...props }: ComponentProps<'div'>) => {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

const DialogTitle = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) => {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  )
}

const DialogDescription = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) => {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
