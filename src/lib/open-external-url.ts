/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri } from '@/lib/platform'
import { isSafeUrl } from '@/lib/url-utils'

/**
 * Open a trusted external URL in the system browser (Tauri) or a new tab (web).
 *
 * Use this for first-party destinations (e.g. the Tinfoil dashboard) where the
 * "you're leaving the app" confirmation in {@link useExternalLinkDialog} would
 * just be noise. Untrusted, in-content links should still go through that dialog.
 *
 * The URL is validated with {@link isSafeUrl} (http/https only) before opening,
 * so a caller mistake can't smuggle a `javascript:` scheme into `window.open`.
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (!isSafeUrl(url)) {
    console.error('Refusing to open unsafe URL:', url)
    return
  }
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
