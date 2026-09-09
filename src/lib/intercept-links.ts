/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { openExternalUrl } from './open-external-url'
import { isTauri } from './platform'
import { isSafeUrl } from './url-utils'

const handler = async (event: MouseEvent) => {
  if (event.defaultPrevented) {
    return
  }
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
  if (!anchor) {
    return
  }
  const url = new URL(anchor.href)
  // app://, file://, or any origin you own stays inside
  if (url.origin === location.origin || url.protocol === 'app:') {
    return
  }
  event.preventDefault()
  if (!isSafeUrl(anchor.href)) {
    return
  }

  try {
    await openExternalUrl(anchor.href)
  } catch (error) {
    console.error('Failed to open URL externally:', error)
    // There is no dialog to surface an error here, so retry in the app's own
    // webview — but only under Tauri, where the failure came from the OS opener.
    // On web openExternalUrl already called window.open, so retrying it would
    // just repeat the call that threw.
    if (isTauri()) {
      window.open(anchor.href, '_blank', 'noopener,noreferrer')
    }
  }
}

/**
 * Intercepts clicks on links and opens them in the system's default browser
 * in Tauri, and in a new tab in the browser.
 */
export const initializeLinkInterception = () => {
  document.addEventListener('click', handler)

  return () => {
    document.removeEventListener('click', handler)
  }
}
