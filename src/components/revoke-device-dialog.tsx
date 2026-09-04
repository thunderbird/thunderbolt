/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
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

type RevokeDeviceDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isPending: boolean
  variant: 'trusted' | 'pending' | 'cli'
}

const descriptions = {
  trusted: msg`The device will be signed out and its local data will be cleared on next sync. This device will need to sign in again to use sync.`,
  pending: msg`This will deny the device access to your encrypted data. The device will need to set up sync again.`,
  cli: msg`The CLI will be signed out and must sign in again before it can use your Thunderbolt account.`,
}

export const RevokeDeviceDialog = ({ open, onOpenChange, onConfirm, isPending, variant }: RevokeDeviceDialogProps) => {
  const { i18n, t } = useLingui()
  const isPendingVariant = variant === 'pending'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isPendingVariant ? (
              <Trans>Deny this device?</Trans>
            ) : variant === 'cli' ? (
              <Trans>Revoke this CLI?</Trans>
            ) : (
              <Trans>Revoke this device?</Trans>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>{i18n._(descriptions[variant])}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            {isPending ? (isPendingVariant ? t`Denying…` : t`Revoking…`) : isPendingVariant ? t`Deny` : t`Revoke`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
