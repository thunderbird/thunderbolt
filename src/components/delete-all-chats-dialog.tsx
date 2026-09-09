/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { forwardRef } from 'react'

import { ImperativeConfirmActionDialog, type ConfirmActionDialogRef } from '@/components/ui/confirm-action-dialog'

export type DeleteAllChatsDialogRef = ConfirmActionDialogRef

type DeleteAllChatsDialogProps = {
  isPending?: boolean
  onConfirm: () => void
}

export const DeleteAllChatsDialog = forwardRef<DeleteAllChatsDialogRef, DeleteAllChatsDialogProps>((props, ref) => {
  const { t } = useLingui()

  return (
    <ImperativeConfirmActionDialog
      ref={ref}
      title={t`Delete all chats?`}
      description={t`This will permanently delete all your chats.`}
      confirmLabel={t`Delete All Chats`}
      {...props}
    />
  )
})

DeleteAllChatsDialog.displayName = 'DeleteAllChatsDialog'
