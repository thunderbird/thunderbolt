/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { MobileActionSheet, MobileActionSheetFooter } from '@/components/ui/mobile-action-sheet'
import { useIsMobile } from '@/hooks/use-mobile'

export type DeleteChatDialogRef = {
  open: () => void
  close: () => void
}

type DeleteChatDialogProps = {
  onCancel?: () => void
  onConfirm: () => void
}

export const DeleteChatDialog = forwardRef<DeleteChatDialogRef, DeleteChatDialogProps>(
  ({ onCancel, onConfirm }, ref) => {
    const [open, setOpen] = useState(false)
    const { isMobile } = useIsMobile()
    const cancelButtonRef = useRef<HTMLButtonElement>(null)

    const handleCancel = () => {
      setOpen(false)
      onCancel?.()
    }

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
    }))

    if (isMobile) {
      return (
        <MobileActionSheet
          open={open}
          onOpenChange={(nextOpen) => {
            if (nextOpen) {
              setOpen(true)
              return
            }
            handleCancel()
          }}
          initialFocus={() => {
            cancelButtonRef.current?.focus()
            return false
          }}
          title="Delete this chat?"
          description="This will permanently delete this chat."
          role="alertdialog"
        >
          <MobileActionSheetFooter>
            <Button ref={cancelButtonRef} variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirm}>
              Delete Chat
            </Button>
          </MobileActionSheetFooter>
        </MobileActionSheet>
      )
    }

    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this chat.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={onConfirm}>
              Delete Chat
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  },
)

DeleteChatDialog.displayName = 'DeleteChatDialog'
