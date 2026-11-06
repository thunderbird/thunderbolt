/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export type SyncEnableWarningDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

/**
 * Reusable dialog shown before enabling cloud sync. Warns that synced data
 * is not encrypted. Use in preferences and header sync controls.
 */
export const SyncEnableWarningDialog = ({ open, onOpenChange, onConfirm }: SyncEnableWarningDialogProps) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>Enable sync?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>
            At this time, synced data is not encrypted. Enabling sync will store your data on our servers without
            encryption. Do you want to continue?
          </Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} variant="destructive">
          <Trans>Enable sync without encryption</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
