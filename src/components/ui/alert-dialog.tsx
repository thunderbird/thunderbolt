/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ComponentProps, type MouseEvent, useCallback } from 'react'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'

import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

const AlertDialog = ({ ...props }: ComponentProps<typeof AlertDialogPrimitive.Root>) => {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

const AlertDialogTrigger = ({ ...props }: ComponentProps<typeof AlertDialogPrimitive.Trigger>) => {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

const AlertDialogPortal = ({ ...props }: ComponentProps<typeof AlertDialogPrimitive.Portal>) => {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}

const AlertDialogOverlay = ({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Overlay>) => {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 backdrop-blur-md',
        className,
      )}
      {...props}
    />
  )
}

const AlertDialogContent = ({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) => {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-2xl border p-6 shadow-lg duration-200 sm:max-w-lg',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

const AlertDialogHeader = ({ className, ...props }: ComponentProps<'div'>) => {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

const AlertDialogFooter = ({ className, ...props }: ComponentProps<'div'>) => {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

const AlertDialogTitle = ({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) => {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-lg font-semibold', className)}
      {...props}
    />
  )
}

const AlertDialogDescription = ({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Description>) => {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}

const AlertDialogAction = ({ className, onClick, ...props }: ComponentProps<typeof AlertDialogPrimitive.Action>) => {
  const { triggerSelection } = useHaptics()
  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      triggerSelection()
      onClick?.(e)
    },
    [onClick, triggerSelection],
  )
  return <AlertDialogPrimitive.Action className={cn(buttonVariants(), className)} onClick={handleClick} {...props} />
}

const AlertDialogCancel = ({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Cancel>) => {
  return <AlertDialogPrimitive.Cancel className={cn(buttonVariants({ variant: 'outline' }), className)} {...props} />
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
