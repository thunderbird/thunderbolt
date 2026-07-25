/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'

/**
 * Dirty-form discard prompt for the skill create/edit flows. Thin wrapper
 * over ConfirmActionDialog so it inherits the responsive mobile bottom
 * sheet / desktop alert dialog treatment.
 */
export const DiscardCreateDialog = ({
  open,
  onOpenChange,
  onConfirm,
  title = 'Leave without creating?',
  description = "You'll lose what you've added so far.",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  title?: string
  description?: string
}) => (
  <ConfirmActionDialog
    open={open}
    title={title}
    description={description}
    confirmLabel="Discard"
    cancelLabel="Keep editing"
    onConfirm={onConfirm}
    onCancel={() => onOpenChange(false)}
  />
)
