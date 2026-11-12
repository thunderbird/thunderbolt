/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'

/** Explain the boundary between moving a conversation and moving its working environment. */
export const ProjectMoveConfirmationDialog = ({
  open,
  isPending,
  onConfirm,
  onCancel,
}: {
  open: boolean
  isPending: boolean
  onConfirm: () => void
  onCancel: () => void
}) => {
  const { t } = useLingui()
  return (
    <ConfirmActionDialog
      open={open}
      title={t`Move chat to a different environment?`}
      description={
        <Trans>
          Only the chat context will move. Files, running apps, and other environment state will stay in the original
          environment.
        </Trans>
      }
      confirmLabel={t`Move chat`}
      confirmVariant="default"
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
