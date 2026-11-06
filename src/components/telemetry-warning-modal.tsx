/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { forwardRef, useImperativeHandle, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'

export type TelemetryWarningModalRef = {
  open: () => void
  close: () => void
}

type TelemetryWarningModalProps = {
  onDisableTelemetry: () => Promise<void>
}

export const TelemetryWarningModal = forwardRef<TelemetryWarningModalRef, TelemetryWarningModalProps>(
  ({ onDisableTelemetry }, ref) => {
    const [open, setOpen] = useState(false)

    const handleClose = () => {
      setOpen(false)
    }

    const handleDisableTelemetry = async () => {
      await onDisableTelemetry()
      handleClose()
    }

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: handleClose,
    }))

    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Preview Features Will Be Disabled</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Turning off telemetry will disable all preview features. Are you sure you want to continue?</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleClose}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisableTelemetry}>
              <Trans>Disable Telemetry</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  },
)

TelemetryWarningModal.displayName = 'TelemetryWarningModal'
