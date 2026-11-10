/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { RenameDialog } from '@/components/rename-dialog'
import { defaultChatTitle } from '@/lib/constants'

type RenameChatDialogProps = {
  open: boolean
  title: string | null
  onOpenChange: (open: boolean) => void
  onRename: (title: string) => void
}

export const RenameChatDialog = ({ open, title, onOpenChange, onRename }: RenameChatDialogProps) => {
  const { t } = useLingui()
  return (
    <RenameDialog
      open={open}
      name={title ?? defaultChatTitle}
      fallbackName={defaultChatTitle}
      title={t`Rename chat`}
      inputLabel={t`Chat name`}
      onOpenChange={onOpenChange}
      onRename={(name) => {
        onRename(name)
        onOpenChange(false)
      }}
    />
  )
}
