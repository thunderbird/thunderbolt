/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getCapabilities, isTauri } from '@/lib/platform'
import { getLocalSetting } from '@/stores/local-settings-store'

/**
 * Custom fetch function that handles CORS issues by routing through Tauri when available
 * @param input - The resource to fetch
 * @param init - Optional request configuration
 * @returns Promise that resolves to the Response
 */
export const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isTauri()) {
    return globalThis.fetch(input, init)
  }

  if (getLocalSetting('isNativeFetchEnabled')) {
    // The "Use Native Fetch" dev setting can only be toggled on in builds
    // compiled with `--features native_fetch`; guard against stale `true`
    // values from prior builds so we don't invoke an unregistered plugin
    // ("plugin http not found").
    const { native_fetch: nativeFetchAvailable } = await getCapabilities()
    if (nativeFetchAvailable) {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
      return tauriFetch(input, init)
    }
  }

  return globalThis.fetch(input, init)
}

// Bun's `fetch` type expects a `preconnect` method.
fetch.preconnect = () => Promise.resolve(false)
