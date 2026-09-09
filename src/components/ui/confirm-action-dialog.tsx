/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { forwardRef, useImperativeHandle, useRef, useState } from 'react'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { MobileActionSheet, MobileActionSheetFooter } from '@/components/ui/mobile-action-sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useLingui } from '@lingui/react/macro'

type ConfirmActionDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  /** Disables the confirm button (with a spinner) while the caller's action
   *  is in flight, so a double-tap can't fire `onConfirm` twice. */
  isPending?: boolean
  onConfirm: () => void
  /** Fires on every non-confirm dismissal: Cancel, Escape, and backdrop. */
  onCancel: () => void
}

/**
 * Responsive destructive-action confirmation: a bottom action sheet on
 * mobile, an alert dialog on desktop. The platform branch, alertdialog
 * semantics, and cancel-first initial focus (so a stray Enter can't
 * destroy anything) live here so confirmation prompts can't drift apart.
 */
export const ConfirmActionDialog = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  isPending = false,
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  // Default resolved in the body, not the signature: a parameter default is
  // evaluated at module scope where `t` would freeze at the boot locale.
  const cancelText = cancelLabel ?? t`Cancel`
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  if (isMobile) {
    return (
      <MobileActionSheet
        open={open}
        onOpenChange={(nextOpen) => !nextOpen && onCancel()}
        // Cancel-first focus so a stray Enter can't destroy anything.
        initialFocus={() => {
          cancelButtonRef.current?.focus()
          return false
        }}
        title={title}
        description={description}
        role="alertdialog"
      >
        <MobileActionSheetFooter>
          <Button ref={cancelButtonRef} variant="outline" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button variant="destructive" isLoading={isPending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </MobileActionSheetFooter>
      </MobileActionSheet>
    )
  }

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Radix's Cancel closes the dialog itself; onCancel arrives once
              via onOpenChange(false), so no onClick here. */}
          <AlertDialogCancel>{cancelText}</AlertDialogCancel>
          <Button variant="destructive" isLoading={isPending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export type ConfirmActionDialogRef = {
  open: () => void
  close: () => void
}

type ImperativeConfirmActionDialogProps = Omit<ConfirmActionDialogProps, 'open' | 'onCancel'> & {
  onCancel?: () => void
}

/**
 * ConfirmActionDialog that owns its open state and exposes it through an
 * imperative `{ open, close }` ref — for callers that open the prompt from a
 * menu action and close it from a mutation callback. Every dismissal closes
 * the dialog itself before invoking the optional `onCancel` cleanup.
 */
export const ImperativeConfirmActionDialog = forwardRef<ConfirmActionDialogRef, ImperativeConfirmActionDialogProps>(
  ({ onCancel, ...props }, ref) => {
    const [open, setOpen] = useState(false)

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
    }))

    return (
      <ConfirmActionDialog
        {...props}
        open={open}
        onCancel={() => {
          setOpen(false)
          onCancel?.()
        }}
      />
    )
  },
)

ImperativeConfirmActionDialog.displayName = 'ImperativeConfirmActionDialog'
