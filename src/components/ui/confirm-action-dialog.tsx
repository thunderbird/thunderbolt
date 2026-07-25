/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'

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

type ConfirmActionDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
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
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) => {
  const { isMobile } = useIsMobile()
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
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
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
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
