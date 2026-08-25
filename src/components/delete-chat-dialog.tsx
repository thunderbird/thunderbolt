/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { forwardRef } from 'react'

import { ImperativeConfirmActionDialog, type ConfirmActionDialogRef } from '@/components/ui/confirm-action-dialog'

export type DeleteChatDialogRef = ConfirmActionDialogRef

type DeleteChatDialogProps = {
  isPending?: boolean
  onCancel?: () => void
  onConfirm: () => void
}

export const DeleteChatDialog = forwardRef<DeleteChatDialogRef, DeleteChatDialogProps>((props, ref) => {
  const { t } = useLingui()

  return (
    <ImperativeConfirmActionDialog
      ref={ref}
      title={t`Delete this chat?`}
      description={t`This will permanently delete this chat.`}
      confirmLabel={t`Delete Chat`}
      {...props}
    />
  )
})

DeleteChatDialog.displayName = 'DeleteChatDialog'
