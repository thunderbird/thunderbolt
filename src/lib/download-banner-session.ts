/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lsKey = 'download_banner_state'
const ssKey = 'download_banner_session_init'

const advanceSessionState = (): void => {
  if (sessionStorage.getItem(ssKey)) {
    return
  }
  sessionStorage.setItem(ssKey, 'true')

  const state = localStorage.getItem(lsKey)
  if (state === 'dismissed') {
    // One session has passed since the user dismissed — mark it as skipped
    localStorage.setItem(lsKey, 'skipped')
  } else if (state === 'skipped') {
    // The skip session is over — clear state so the banner shows again
    localStorage.removeItem(lsKey)
  }
}

advanceSessionState()

/**
 * Returns true when the banner should be shown in the current session.
 * Must be called after module load (state already advanced by advanceSessionState).
 */
export const shouldShowDownloadBanner = (): boolean => {
  return localStorage.getItem(lsKey) === null
}

/**
 * Records that the user dismissed the banner.
 * The banner will be hidden for the next session and shown again the one after.
 */
export const dismissDownloadBanner = (): void => {
  localStorage.setItem(lsKey, 'dismissed')
}
