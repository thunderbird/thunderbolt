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
      title={t`Delete chats outside projects?`}
      description={t`This will delete all chats that aren't in a project. Chats inside projects will be kept.`}
      confirmLabel={t`Delete chats`}
      {...props}
    />
  )
})

DeleteAllChatsDialog.displayName = 'DeleteAllChatsDialog'
