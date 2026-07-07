/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const storageKey = 'device_approval_return'

/**
 * Stashes the `/device` approval URL (path + `user_code`) before an unauthenticated
 * visitor is redirected into the normal auth flow, so the approval page can be replayed
 * pre-filled once they land back authenticated — instead of forcing a link re-open.
 *
 * localStorage (not sessionStorage) because the login round-trip may complete in a
 * different tab (a magic link opened from an email client) or survive an app relaunch
 * during desktop SSO — sessionStorage is per-tab and would be wiped. Same rationale as
 * `oauth-state.ts`. The value is consumed once (read-and-clear), so a stale entry can't
 * accumulate.
 */
export const saveDeviceApprovalReturn = (returnUrl: string): void => {
  localStorage.setItem(storageKey, returnUrl)
}

/**
 * Reads and clears the stashed return URL. Returns it only when it is a safe same-origin
 * relative path (single leading `/`), so a poisoned value can never redirect off-origin.
 */
export const takeDeviceApprovalReturn = (): string | null => {
  const value = localStorage.getItem(storageKey)
  localStorage.removeItem(storageKey)
  return value?.startsWith('/') && !value.startsWith('//') ? value : null
}
