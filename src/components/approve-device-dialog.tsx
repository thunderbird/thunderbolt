/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type ApproveDeviceDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isPending: boolean
  /**
   * Rendered above the footer when the last attempt failed. The dialog stays
   * OPEN on failure so this sits next to the button that retries it — see the
   * confirm control below.
   */
  error?: string | null
}

export const ApproveDeviceDialog = ({ open, onOpenChange, onConfirm, isPending, error }: ApproveDeviceDialogProps) => {
  const { t } = useLingui()
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Approve this device?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              This will share your encryption key with the device, allowing it to decrypt and sync your data.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-[length:var(--font-size-sm)] text-destructive" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          {/*
          A plain Button, NOT AlertDialogAction, which is a Radix
          `DialogPrimitive.Close` and would dismiss the dialog whether the
          mutation resolved or rejected (THU-887). The caller closes it from the
          mutation's success callback instead, so a failure keeps this button on
          screen as the retry.
        */}
          <Button onClick={onConfirm} disabled={isPending} isLoading={isPending} loadingLabel={t`Approving…`}>
            <Trans>Approve</Trans>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
