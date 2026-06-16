/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
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
import { useAuth } from '@/contexts'
import { isSsoMode } from '@/lib/auth-mode'
import { signOutAndWipe as defaultSignOutAndWipe } from '@/lib/cleanup'

type LogoutModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Injectable for tests. Defaults to the real {@link signOutAndWipe} — the shipped
   * UI never overrides this. Lets the test pass a stub instead of
   * `mock.module('@/lib/cleanup', ...)`, which would leak across files (see
   * `docs/development/testing.md` §65).
   */
  signOutAndWipe?: typeof defaultSignOutAndWipe
}

export const LogoutModal = ({ open, onOpenChange, signOutAndWipe = defaultSignOutAndWipe }: LogoutModalProps) => {
  const authClient = useAuth()
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  // Ref mirrors the state for synchronous reads: Radix fires onOpenToggle in the same
  // click-handler tick as our onClick, before React commits the setState above.
  const isLoggingOutRef = useRef(false)

  // Per addendum decision #16 (THU-549 §5): signing out always wipes the active trust
  // domain's local data. The previous "keep my data" affordance was incompatible with
  // per-trust-domain SQLite files — leftover data without a matching auth token has no
  // path back to the user.
  const handleLogout = () => {
    // Ref-guard at entry: the button's `disabled={isLoggingOut}` only applies
    // after React commits the setState below. A rapid double-click (or a
    // queued click event firing in the same tick as the first) would
    // otherwise launch a second signOutAndWipe concurrent with the first.
    if (isLoggingOutRef.current) {
      return
    }
    isLoggingOutRef.current = true
    setIsLoggingOut(true)
    // SSO lands on `/signed-out` because IdP-bounce-back would silently re-auth the
    // user on reload; consumer mode reloads so the user re-enters the normal unauth
    // landing (sign-in or waitlist).
    void signOutAndWipe({
      signOut: async () => {
        await authClient.signOut()
      },
      onComplete: () => {
        if (isSsoMode()) {
          window.location.replace('/signed-out')
        } else {
          window.location.reload()
        }
      },
    })
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (isLoggingOutRef.current) {
      return
    }
    onOpenChange(newOpen)
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Log out</AlertDialogTitle>
          <AlertDialogDescription>
            Signing out will remove all chats, settings, and cached data from this device.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoggingOut}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {isLoggingOut ? 'Logging out…' : 'Log out'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
