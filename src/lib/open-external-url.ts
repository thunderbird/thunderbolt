/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri } from '@/lib/platform'

export type OpenExternalUrlDeps = {
  isTauri: () => boolean
  openInTauri: (url: string) => Promise<void>
}

// Imported lazily so this module stays usable (and testable) on web without
// evaluating the Tauri plugin. It does NOT keep the plugin out of the web
// bundle — several modules in the entry graph import it statically.
const defaultDeps: OpenExternalUrlDeps = {
  isTauri,
  openInTauri: async (url) => {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  },
}

/**
 * Opens a URL outside the app: the OS default browser under Tauri, a new tab on web.
 * Rejects when the platform opener fails, so callers can surface an error; callers
 * are also responsible for validating the URL with `isSafeUrl` first.
 */
export const openExternalUrl = async (url: string, deps: OpenExternalUrlDeps = defaultDeps): Promise<void> => {
  if (deps.isTauri()) {
    await deps.openInTauri(url)
    return
  }
  // noopener causes window.open to return null even on success,
  // so we can't use the return value to detect popup-blocked
  window.open(url, '_blank', 'noopener,noreferrer')
}
