/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri } from './platform'

const embedStorageKey = 'thunderbolt_embedded'

/**
 * Whether this page load is embedded in a native app's WebView. True when the
 * URL carries `?embed=app` (now or on an earlier load): the marker is saved to
 * localStorage so it survives navigation (the index redirect drops the query)
 * and app restarts, and nothing in the web UI clears it. The Tauri shell is
 * never embedded in this sense. `isEmbedded` calls this once at boot; call it
 * directly only in tests.
 */
export const detectEmbedded = (): boolean => {
  if (isTauri()) {
    return false
  }
  const marked = new URLSearchParams(window.location.search).get('embed') === 'app'
  // A cosmetic marker must never block boot: storage can be full or disabled. The current query counts regardless.
  try {
    if (marked) {
      localStorage.setItem(embedStorageKey, '1')
    }
    return marked || localStorage.getItem(embedStorageKey) === '1'
  } catch {
    return marked
  }
}

const embedded = detectEmbedded()

/**
 * Whether this page load is embedded in a native app, fixed at boot. Called by
 * `header.tsx`. The marker is always read first: all module evaluation finishes
 * before `createRoot().render()`, so the router has not mounted yet.
 */
export const isEmbedded = (): boolean => embedded
