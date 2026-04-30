/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const postUpdateKey = 'thunderbolt_post_update'

/**
 * Sets a flag in localStorage to signal that the app should redirect to root
 * after an update+relaunch. Called before restarting the app.
 */
export const setPostUpdateFlag = () => {
  localStorage.setItem(postUpdateKey, '1')
}

/**
 * Clears the post-update flag. Called when relaunch fails so a stale flag
 * doesn't force-redirect on the next manual app launch.
 */
export const clearPostUpdateFlag = () => {
  localStorage.removeItem(postUpdateKey)
}

/**
 * Checks for and consumes the post-update flag. If the flag is present and the
 * current pathname isn't "/", redirects to root via `window.location.replace`
 * and returns true (caller should skip normal initialization). Otherwise returns false.
 */
export const handlePostUpdateRedirect = (): boolean => {
  const flag = localStorage.getItem(postUpdateKey)
  if (!flag) {
    return false
  }

  localStorage.removeItem(postUpdateKey)

  if (window.location.pathname !== '/') {
    window.location.replace('/')
    return true
  }

  return false
}
