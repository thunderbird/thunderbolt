/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { forwardRef, useImperativeHandle, useState } from 'react'

import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'

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

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
    }))

    return (
      <ConfirmActionDialog
        open={open}
        title="Delete all chats?"
        description="This will permanently delete all your chats."
        confirmLabel="Delete All Chats"
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      />
    )
  },
)

DeleteAllChatsDialog.displayName = 'DeleteAllChatsDialog'
