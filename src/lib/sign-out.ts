/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts/auth-context'
import { isSsoMode } from '@/lib/auth-mode'

/**
 * Confirm sign-out on the server before clearing local data or leaving the app. Returns false when
 * the server refuses or cannot confirm the sign-out, so callers can offer a retry. SSO goes to
 * `/signed-out`, because a reload would send the browser back through the identity provider.
 */
export const signOutAndLeave = async (authClient: AuthClient, clearLocal: () => Promise<void>): Promise<boolean> => {
  try {
    const { data, error } = await authClient.signOut({ fetchOptions: { disableSignal: true } })
    if (error) {
      console.error('Failed to sign out:', error)
    }
    if (error || !data?.success) {
      return false
    }
  } catch (error) {
    console.error('Failed to sign out:', error)
    return false
  }

  try {
    await clearLocal()
  } catch (error) {
    console.error('Failed to clear local data:', error)
  }

  if (isSsoMode()) {
    window.location.replace('/signed-out')
  } else {
    window.location.reload()
  }
  return true
}
