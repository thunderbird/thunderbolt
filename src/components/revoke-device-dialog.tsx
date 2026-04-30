/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
  variant: 'trusted' | 'pending'
}

const descriptions = {
  trusted:
    'The device will be signed out and its local data will be cleared on next sync. This device will need to sign in again to use sync.',
  pending: 'This will deny the device access to your encrypted data. The device will need to set up sync again.',
}

export const RevokeDeviceDialog = ({ open, onOpenChange, onConfirm, isPending, variant }: RevokeDeviceDialogProps) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{variant === 'pending' ? 'Deny this device?' : 'Revoke this device?'}</AlertDialogTitle>
        <AlertDialogDescription>{descriptions[variant]}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} disabled={isPending}>
          {isPending ? (variant === 'pending' ? 'Denying…' : 'Revoking…') : variant === 'pending' ? 'Deny' : 'Revoke'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
