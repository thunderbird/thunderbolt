/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { forwardRef, useImperativeHandle, useState } from 'react'

import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'

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

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
    }))

    return (
      <ConfirmActionDialog
        open={open}
        title="Delete this chat?"
        description="This will permanently delete this chat."
        confirmLabel="Delete Chat"
        onConfirm={onConfirm}
        onCancel={() => {
          setOpen(false)
          onCancel?.()
        }}
      />
    )
  },
)

DeleteChatDialog.displayName = 'DeleteChatDialog'
