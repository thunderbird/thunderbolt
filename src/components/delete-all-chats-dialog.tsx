/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { forwardRef, useImperativeHandle, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Button } from './ui/button'

export type DeleteAllChatsDialogRef = {
  open: () => void
  close: () => void
}

type DeleteAllChatsDialogProps = {
  onConfirm: () => void
}

export const DeleteAllChatsDialog = forwardRef<DeleteAllChatsDialogRef, DeleteAllChatsDialogProps>(
  ({ onConfirm }, ref) => {
    const [open, setOpen] = useState(false)

    const handleCancel = () => {
      setOpen(false)
    }

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
    }))

    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all chats?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete all your chats.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={onConfirm}>
              Delete All Chats
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  },
)

DeleteAllChatsDialog.displayName = 'DeleteAllChatsDialog'
