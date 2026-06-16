/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { signOutAndWipe as defaultSignOutAndWipe } from '@/lib/cleanup'

type RevokedDeviceModalProps = {
  open: boolean
  /**
   * Injectable for tests (mirrors the LogoutModal pattern). Avoids a
   * `mock.module('@/lib/cleanup', ...)` here that would leak across files
   * (see `docs/development/testing.md` §65). The shipped UI never overrides.
   */
  signOutAndWipe?: typeof defaultSignOutAndWipe
}

export const RevokedDeviceModal = ({ open, signOutAndWipe = defaultSignOutAndWipe }: RevokedDeviceModalProps) => {
  const wipingRef = useRef(false)

  // Server kicked this device — the active server's auth token is gone, encryption
  // keys are useless without it, and the per-trust-domain DB file has no path back
  // to the user. Per the THU-549 wipe model (addendum decision #16), revocation
  // takes the same path as voluntary logout (minus the Better Auth signOut call —
  // the server already invalidated the session). The user has no opt-out — there's
  // no Cancel button: confirm is the only path.
  const handleConfirm = () => {
    if (wipingRef.current) {
      return
    }
    wipingRef.current = true
    void signOutAndWipe({
      onComplete: () => window.location.replace('/'),
    })
  }

  return (
    <AlertDialog open={open}>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Device access revoked</AlertDialogTitle>
          <AlertDialogDescription>
            This device has been signed out remotely. Your local chats, settings, and cached data will be removed from
            this device.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={handleConfirm} className="bg-destructive text-white hover:bg-destructive/90">
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
